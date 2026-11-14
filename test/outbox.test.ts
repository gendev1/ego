// The outbox and its delivery task. The provider is a fake that keeps one delivery per idempotency key, as a real
// provider with idempotency keys does, and can be told to fail or to hang.
import { expect, test } from "vitest";
import type { OutboxMessage, Sender } from "../src/outbox.ts";
import { PermanentSendError } from "../src/outbox.ts";
import { fakeClock, open, opened, place, reply, tool, waitFor } from "./support.ts";

type Behavior = "ok" | "fail" | "permanent" | "hang";

/** A fake email provider: `plan` says what each call does, then "ok". */
const fakeProvider = (plan: Behavior[] = []) => {
    const deliveries = new Map<string, { to: string; message: OutboxMessage }>();
    const calls: string[] = [];
    const sender: Sender = {
        send: (message, to, key, signal) => {
            calls.push(key);
            const behavior = plan.shift() ?? "ok";
            if (behavior === "fail") return Promise.reject(new Error("503 from the provider"));
            if (behavior === "permanent") return Promise.reject(new PermanentSendError("550 mailbox does not exist"));
            // The provider took it: one delivery per key, whatever the number of calls.
            if (!deliveries.has(key)) deliveries.set(key, { to: to.email, message });
            if (behavior === "hang") {
                // Accepted, but the answer never comes back before the process stops.
                return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
            }
            return Promise.resolve({ id: `provider-${key}` });
        },
    };
    return { sender, deliveries, calls, plan };
};

/** Bob joins, Alice asks for him, Bob accepts: an intro is made between them. */
const INTRO = [
    tool("remember", { text: "Head of ops at a logistics firm.", kind: "role", visibility: "shareable" }),
    reply("Hi Bob."),
    tool("propose_intro", { personId: "bob", reason: "Bob runs logistics ops; Alice needs a logistics partner." }),
    reply("I'll ask Bob."),
    tool("answer_intro", { introId: "intro-1", accept: true }),
    reply("Done."),
];

const makeIntro = async (ego: Awaited<ReturnType<typeof open>>["ego"]) => {
    await ego.say("bob", "Bob", "I run ops at a logistics firm.", { email: "bob@example.com" });
    await ego.say("alice", "Alice", "I need a logistics partner.", { email: "alice@example.com" });
    await ego.say("bob", "Bob", "Happy to meet Alice.");
};

const settled = (ego: Awaited<ReturnType<typeof open>>["ego"], count: number) =>
    waitFor(
        () => ego.outbox(),
        (messages) => messages.length === count && messages.every((message) => message.status !== "queued"),
        `${count} settled messages`,
    );

test("a made intro emails both people, each with the other's address, once", async () => {
    const provider = fakeProvider();
    const { ego } = await open(INTRO, { extra: { sender: provider.sender } });

    await makeIntro(ego);
    const messages = await settled(ego, 2);

    expect(messages.map((message) => [message.message.to, message.status, message.attempts])).toEqual([
        ["alice", "sent", 1],
        ["bob", "sent", 1],
    ]);
    expect(provider.deliveries.get("intro-1:alice")?.to).toBe("alice@example.com");
    expect(provider.deliveries.get("intro-1:alice")?.message.body).toContain("Meet Bob (bob@example.com)");
    expect(provider.deliveries.get("intro-1:bob")?.message.body).toContain("Meet Alice (alice@example.com)");
    expect(provider.calls).toHaveLength(2);
});

test("nothing is sent before both sides said yes", async () => {
    const provider = fakeProvider();
    const { ego } = await open(INTRO.slice(0, 4), { extra: { sender: provider.sender } });

    await ego.say("bob", "Bob", "I run ops at a logistics firm.", { email: "bob@example.com" });
    await ego.say("alice", "Alice", "I need a logistics partner.", { email: "alice@example.com" });

    expect(await ego.outbox()).toEqual([]);
    expect(provider.calls).toEqual([]);
});

test("a failure the provider may recover from is retried, with backoff, until it is sent", async () => {
    const provider = fakeProvider(["fail", "fail"]);
    const { ego } = await open(INTRO, { clock: fakeClock(), extra: { sender: provider.sender } });

    await makeIntro(ego);
    const messages = await settled(ego, 2);

    const alice = messages.find((message) => message.message.to === "alice")!;
    const bob = messages.find((message) => message.message.to === "bob")!;
    // Two failures between them, whichever message got them: three tries for one, or two for each.
    expect(alice.status).toBe("sent");
    expect(bob.status).toBe("sent");
    expect(alice.attempts + bob.attempts).toBe(4);
    expect(alice.lastError ?? bob.lastError).toBeUndefined();
    expect(provider.deliveries.size).toBe(2);
});

test("a permanent failure fails the message at once, with its reason", async () => {
    const provider = fakeProvider(["permanent", "permanent"]);
    const { ego } = await open(INTRO, { extra: { sender: provider.sender } });

    await makeIntro(ego);
    const messages = await settled(ego, 2);

    for (const message of messages) {
        expect(message).toMatchObject({ status: "failed", attempts: 1, lastError: "550 mailbox does not exist" });
    }
});

test("a message fails after its last try", async () => {
    const provider = fakeProvider(Array.from({ length: 20 }, () => "fail" as const));
    const { ego } = await open(INTRO, { clock: fakeClock(), extra: { sender: provider.sender } });

    await makeIntro(ego);
    const messages = await settled(ego, 2);

    for (const message of messages) {
        expect(message).toMatchObject({ status: "failed", attempts: 6, lastError: "503 from the provider" });
    }
});

test("a person without an email address gets nothing sent, and the message says why", async () => {
    const provider = fakeProvider();
    const { ego } = await open(INTRO, { extra: { sender: provider.sender } });

    await ego.say("bob", "Bob", "I run ops at a logistics firm.", { email: "bob@example.com" });
    await ego.say("alice", "Alice", "I need a logistics partner.");
    await ego.say("bob", "Bob", "Happy to meet Alice.");
    const messages = await settled(ego, 2);

    expect(messages.find((message) => message.message.to === "alice")).toMatchObject({
        status: "failed",
        lastError: "alice has no email address",
    });
    expect(messages.find((message) => message.message.to === "bob")?.status).toBe("sent");
    expect([...provider.deliveries.keys()]).toEqual(["intro-1:bob"]);
});

test("a send cut off by the process stopping is sent after the next start, with the same key, once", async () => {
    const storage = place();
    const provider = fakeProvider(["hang", "hang"]);
    const first = await open(INTRO, { storage, extra: { sender: provider.sender } });

    await makeIntro(first.ego);
    await waitFor(async () => provider.calls.length, (calls) => calls === 2, "both sends to start");
    // The provider accepted both, but the process stops before it hears back.
    await first.ego.close();
    opened.splice(opened.indexOf(first.ego), 1);
    expect(provider.deliveries.size).toBe(2);

    const second = await open([], { storage, extra: { sender: provider.sender } });
    const messages = await settled(second.ego, 2);

    expect(messages.map((message) => message.status)).toEqual(["sent", "sent"]);
    // Each message was sent twice with its own key, and the provider kept one delivery of each.
    expect(provider.calls.toSorted()).toEqual(["intro-1:alice", "intro-1:alice", "intro-1:bob", "intro-1:bob"]);
    expect(provider.deliveries.size).toBe(2);
});

test("an address that is not one is refused when the person speaks", async () => {
    const { ego } = await open([reply("Hi.")]);

    await expect(ego.say("alice", "Alice", "Hi.", { email: "not an address" })).rejects.toThrow("Not an email address");
});
