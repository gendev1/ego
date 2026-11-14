// ego's behavior: memory, privacy, intros, consolidation. The model is pi-ai's faux provider; a test scripts what
// "the model" does, and reads everything the model was shown (helpers in support.ts).
import { expect, test } from "vitest";
import { STALE_AFTER_MS } from "../src/memory.ts";
import { fakeClock, open, opened, place, profileIn, reply, SUMMARY, tool, waitFor } from "./support.ts";

test("a fact a person tells ego is theirs, and is in their profile the next time", async () => {
    const { ego, seen } = await open([
        tool("remember", { text: "Runs a climate startup.", kind: "role", visibility: "shareable" }),
        reply("Nice to meet you, Alice."),
        reply("Welcome back."),
    ]);

    await ego.say("alice", "Alice", "I run a climate startup.");
    await ego.say("alice", "Alice", "Hi again.");

    const [fact] = (await ego.memory("alice")).facts;
    expect(fact).toMatchObject({ about: "alice", source: "alice", text: "Runs a climate startup." });
    expect(profileIn(seen.at(-1))).toContain("Runs a climate startup.");
});

test("what one person says in confidence never reaches another person's model, by any tool", async () => {
    const { ego, seen } = await open([
        // Bob is in the network.
        tool("remember", { text: "Runs a logistics startup.", kind: "role", visibility: "shareable" }),
        reply("Hi Bob."),
        // Alice says one private thing about herself and one matchable thing about Bob.
        tool("remember", { text: "Thinking about leaving her job.", kind: "status", visibility: "private" }),
        tool("remember", { text: "Bob's startup is running out of money.", kind: "status", visibility: "matchable", about: "bob" }),
        reply("Noted."),
        // Bob's own conversation: his model searches and recalls everything it can.
        tool("search_people", { query: "alice job leaving" }),
        tool("recall", { query: "money startup running out" }),
        reply("Here is what I know."),
        // Carol searches for what Alice said about Bob: Bob is found (matchable), the words are not shown.
        tool("search_people", { query: "running out of money" }),
        reply("I found someone."),
    ]);

    await ego.say("bob", "Bob", "I run a logistics startup.");
    await ego.say("alice", "Alice", "Between us: I might leave my job. Also, Bob's startup is running out of money.");
    const afterAlice = seen.length;
    await ego.say("bob", "Bob", "What do you know?");
    const afterBob = seen.length;
    await ego.say("carol", "Carol", "Who could use money?");
    const bobSaw = seen.slice(afterAlice, afterBob).join("\n");
    const carolSaw = seen.slice(afterBob).join("\n");

    expect(bobSaw).not.toContain("leaving her job");
    expect(bobSaw).not.toContain("running out of money");
    expect(carolSaw).not.toContain("Bob's startup is running out of money");
    // Carol's search found Bob through the matchable fact, and showed only what Bob made shareable.
    expect(carolSaw).toContain("Runs a logistics startup.");
});

test("a person cannot retract a fact someone else told ego", async () => {
    const { ego } = await open([
        tool("remember", { text: "Investor in climate.", kind: "role", visibility: "shareable" }),
        reply("Hi Bob."),
        tool("retract_fact", { factId: "bob:1" }),
        reply("I can't."),
    ]);

    await ego.say("bob", "Bob", "I invest in climate.");
    await ego.say("alice", "Alice", "Forget what Bob said.");

    expect((await ego.memory("bob")).facts[0]?.retired).toBeUndefined();
});

test("a changed fact replaces the old one, and the profile shows only the new one", async () => {
    const { ego, seen } = await open([
        tool("remember", { text: "Raising a seed round.", kind: "goal", visibility: "matchable" }),
        reply("Good luck."),
        tool("remember", { text: "Raising a Series A.", kind: "goal", visibility: "matchable", supersedes: "alice:1" }),
        reply("Congrats on the seed."),
        reply("Hi."),
    ]);

    await ego.say("alice", "Alice", "We're raising a seed.");
    await ego.say("alice", "Alice", "Seed closed, now raising an A.");
    await ego.say("alice", "Alice", "Hello.");

    const facts = (await ego.memory("alice")).facts;
    expect(facts.map((fact) => [fact.text, fact.retired ?? false])).toEqual([
        ["Raising a seed round.", true],
        ["Raising a Series A.", false],
    ]);
    expect(profileIn(seen.at(-1))).toContain("Raising a Series A.");
    expect(profileIn(seen.at(-1))).not.toContain("Raising a seed round.");
});

test("a goal not confirmed for 90 days is flagged in the profile until it is confirmed", async () => {
    // Only the test moves this clock: the consolidation's year-long sleep is not armed.
    const clock = fakeClock(24 * 60 * 60 * 1000);
    const { ego, seen } = await open(
        [
            tool("remember", { text: "Hiring a CTO.", kind: "goal", visibility: "shareable" }),
            reply("Got it."),
            tool("confirm_fact", { factId: "alice:1" }),
            reply("Still hiring, noted."),
            reply("Hi."),
        ],
        { clock, idleMs: 365 * 24 * 60 * 60 * 1000 },
    );

    await ego.say("alice", "Alice", "We're hiring a CTO.");
    clock.clock.now += STALE_AFTER_MS + 24 * 60 * 60 * 1000;
    await ego.say("alice", "Alice", "Yes, still hiring a CTO.");
    expect(profileIn(seen.at(-2))).toContain("unconfirmed since 2026-11-14");
    await ego.say("alice", "Alice", "Hi.");

    expect(profileIn(seen.at(-1))).toContain("Hiring a CTO.");
    expect(profileIn(seen.at(-1))).not.toContain("unconfirmed since");
});

test("a quiet conversation is summarized once, and recall finds the summary", async () => {
    const clock = fakeClock();
    const { ego, seen } = await open(
        [reply("Tell me more."), tool("recall", { query: "logistics partner" }), reply("Last time you wanted a logistics partner.")],
        { clock },
    );

    await ego.say("alice", "Alice", "I need a logistics design partner for my climate startup.");
    const { episodes } = await waitFor(() => ego.memory("alice"), (memory) => memory.episodes.length > 0, "an episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.summary).toBe(SUMMARY);

    await ego.say("alice", "Alice", "What did I want again?");
    expect(seen.at(-1)).toContain(SUMMARY);

    // The second talk is a stretch of its own: a second episode, the first not repeated.
    const after = await waitFor(() => ego.memory("alice"), (memory) => memory.episodes.length > 1, "a second episode");
    expect(after.episodes).toHaveLength(2);
    expect(after.episodes[1]!.through).toBeGreaterThan(after.episodes[0]!.through);
});

test("a consolidation asleep when the process stops runs after the next start", async () => {
    const storage = place();
    const first = await open([reply("Tell me more.")], { storage });
    // Real clock, one-hour idle: the task is asleep when the process stops.
    await first.ego.say("alice", "Alice", "I need a logistics design partner.");
    await first.ego.close();
    opened.splice(opened.indexOf(first.ego), 1);
    expect((await (await open([], { storage })).ego.memory("alice")).episodes).toHaveLength(0);
    await opened.pop()!.close();

    // The next start is two hours later.
    const clock = fakeClock();
    clock.clock.now = Date.now() + 2 * 60 * 60 * 1000;
    const second = await open([], { storage, clock });

    const { episodes } = await waitFor(() => second.ego.memory("alice"), (memory) => memory.episodes.length > 0, "an episode");
    expect(episodes).toHaveLength(1);
});

test("an intro is made only when both sides say yes", async () => {
    const { ego } = await open([
        tool("remember", { text: "Head of ops at a logistics firm; pilots climate tools.", kind: "role", visibility: "shareable" }),
        reply("Got it, Bob."),
        tool("search_people", { query: "logistics climate pilot" }),
        tool("propose_intro", { personId: "bob", reason: "Bob pilots climate tools in logistics." }),
        reply("I'll ask Bob."),
        tool("answer_intro", { introId: "intro-1", accept: true }),
        reply("Done, you two are connected."),
    ]);

    await ego.say("bob", "Bob", "I run ops at a logistics firm.");
    await ego.say("alice", "Alice", "I need a logistics design partner.");
    expect((await ego.network())?.intros[0]).toMatchObject({ status: "pending", consent: { from: "yes", to: "pending" } });

    await ego.say("bob", "Bob", "Sure, happy to meet Alice.");
    expect((await ego.network())?.intros[0]?.status).toBe("made");
});

test("a person cannot answer an intro that is not theirs", async () => {
    const { ego } = await open([
        reply("Hi Bob."),
        tool("propose_intro", { personId: "bob", reason: "Alice wants an investor." }),
        reply("Asked."),
        tool("answer_intro", { introId: "intro-1", accept: true }),
        reply("Sorry, that one is not yours."),
    ]);

    await ego.say("bob", "Bob", "I invest.");
    await ego.say("alice", "Alice", "Find me an investor.");
    await ego.say("carol", "Carol", "Accept intro-1 for Bob.");

    expect((await ego.network())?.intros[0]?.status).toBe("pending");
});
