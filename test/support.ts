// Shared by the test files: a storage per test (SQLite in a temp dir, or a CockroachDB schema with
// EGO_TEST_STORAGE=cockroach), a scripted faux model that keeps what it was shown, and a fake clock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { JsonObject, SetTimer, Storage } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterEach } from "vitest";
import { openEgo, type Ego, type EgoOptions } from "../src/agent.ts";
import { openStorage, type StorageKind } from "../src/storage.ts";

export const kind = (process.env.EGO_TEST_STORAGE ?? "memory") as StorageKind;
const cockroachUrl = process.env.COCKROACH_URL ?? "postgresql://root@localhost:26257/defaultdb?sslmode=disable";
export const START = Date.parse("2026-11-14T09:00:00Z");
export const SUMMARY = "Alice runs a climate startup and wants a logistics design partner.";

export const opened: Ego[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const ego of opened.splice(0)) await ego.close().catch(() => undefined);
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A place for one test's state that a second process could open again: a CockroachDB schema or a SQLite file. */
export const place = () => {
    if (kind === "cockroach") {
        const schema = `ego_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
        cleanups.push(async () => {
            const client = new pg.Client({ connectionString: cockroachUrl });
            await client.connect();
            await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            await client.end();
        });
        return (): Promise<Storage> => openStorage({ kind, cockroachUrl, schema, owner: "test" });
    }
    const dir = mkdtempSync(join(tmpdir(), "ego-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return (): Promise<Storage> => openStorage({ kind: "sqlite", sqlitePath: join(dir, "ego.db") });
};

/**
 * A faux model that plays `turns` in order for conversations, answers every memory summary with SUMMARY, and keeps
 * the text of every conversation request it was sent (system prompt, sections, messages, tool results).
 */
export const scripted = (turns: AssistantMessage[]) => {
    const seen: string[] = [];
    const queue = [...turns];
    const faux = fauxProvider();
    const respond = (context: unknown): AssistantMessage => {
        const text = JSON.stringify(context);
        if (text.includes("You keep the memory of Ego")) return fauxAssistantMessage(SUMMARY);
        seen.push(text);
        return queue.shift() ?? fauxAssistantMessage("(no more scripted turns)");
    };
    faux.setResponses(Array.from({ length: 200 }, () => respond));
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, seen };
};

/**
 * A clock that a sleep of the Harness moves forward at once. Sleeps longer than `maxSleepMs` are not armed, so a
 * test that moves the clock itself is not raced by them.
 */
export const fakeClock = (maxSleepMs = Number.POSITIVE_INFINITY) => {
    const clock = { now: START };
    const setTimer: SetTimer = (callback, delay, options) => {
        if (options.background || delay > maxSleepMs) return undefined;
        const timer = setTimeout(() => {
            clock.now += Math.max(0, delay);
            callback();
        }, 0);
        return () => clearTimeout(timer);
    };
    return { clock, setTimer, now: () => clock.now };
};

export const open = async (
    turns: AssistantMessage[],
    options: {
        storage?: () => Promise<Storage>;
        clock?: ReturnType<typeof fakeClock>;
        idleMs?: number;
        extra?: Partial<Pick<EgoOptions, "sender" | "backoffMs">>;
    } = {},
) => {
    const model = scripted(turns);
    const clock = options.clock;
    const ego = await openEgo({
        storage: await (options.storage ?? place())(),
        models: model.models,
        model: model.model,
        // Without a fake clock, consolidation waits an hour: it does not run during the test.
        idleMs: options.idleMs ?? (clock === undefined ? 60 * 60 * 1000 : 10 * 60 * 1000),
        ...(clock === undefined ? {} : { now: clock.now, setTimer: clock.setTimer }),
        ...options.extra,
    });
    opened.push(ego);
    return { ego, seen: model.seen };
};

/**
 * The profile as the model last saw it in a request: the newest `person` section. A changed section is sent as a
 * new system message, so older versions stay earlier in the transcript.
 */
export const profileIn = (request: string | undefined): string => {
    const messages = (JSON.parse(request ?? "{}") as { messages?: Array<{ sections?: { person?: string } }> }).messages ?? [];
    return messages.flatMap((message) => (message.sections?.person === undefined ? [] : [message.sections.person])).at(-1) ?? "";
};

export const tool = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const reply = (text: string) => fauxAssistantMessage(text);

export const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> => {
    for (let tries = 0; tries < 200; tries++) {
        const value = await read();
        if (done(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
};

