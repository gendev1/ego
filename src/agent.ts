// ego on pi-durable: one Harness over one storage (a SQLite file, or a CockroachDB schema; see `storage.ts`). Every person has one conversation, found again by their id,
// and all of them share one network document. The root conversation is the desk: no model runs in it.
//
//   say(person, text) ─► desk.commit: person + their conversation ─► submit(text) ─► model + tools ─► answer
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    configure,
    createRegistry,
    Harness,
    type ConversationId,
    type ModelRef,
    type SetTimer,
    type Storage,
} from "@earendil-works/pi-durable";
import { Consolidations, consolidateTask } from "./consolidate.ts";
import { Episodes, Facts } from "./memory.ts";
import { consoleSender, createOutbox, type Sender } from "./outbox.ts";
import { Network } from "./network.ts";
import { egoExtension } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

export interface EgoOptions {
    /** Where the Harness keeps everything: open it with `openStorage` (`storage.ts`). */
    readonly storage: Storage;
    readonly models: Models;
    readonly model: ModelRef;
    /** The model of the consolidation task: a cheaper one will do. Default: `model`. */
    readonly memoryModel?: ModelRef;
    /** How long a person is quiet before their conversation is summarized. Default 10 minutes. */
    readonly idleMs?: number;
    readonly now?: () => number;
    /** The timers of the Harness's sleeps; a test gives one that goes with a fake `now`. */
    readonly setTimer?: SetTimer;
    /** How the outbox sends email. Default: printed to the console. */
    readonly sender?: Sender;
    /** The outbox's first retry backoff. Default 30 s. */
    readonly backoffMs?: number;
}

/** What the channel a person came from knows about them. */
export interface SayOptions {
    readonly email?: string;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The desk owns the consolidation tasks as background work: they outlive an abort of a conversation. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/** The text of an assistant entry's message. */
const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.flatMap((part) => (part?.type === "text" ? [part.text as string] : [])).join("")
          : "";

export const openEgo = async (options: EgoOptions) => {
    const now = options.now ?? Date.now;
    const registry = createRegistry();
    let opened: Harness | undefined;
    const consolidate = consolidateTask({
        harness: () => opened!,
        model: options.memoryModel ?? options.model,
        idleMs: options.idleMs ?? 10 * 60 * 1000,
        now,
    });

    const outbox = createOutbox({
        harness: () => opened!,
        sender: options.sender ?? consoleSender(),
        now,
        ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    });

    registry.install(egoExtension(now, outbox, [consolidate, outbox.deliver]));

    const harness = await Harness.open(
        options.storage,
        {
            models: options.models,
            registry,
            identity: { attribution: null },
            settings: { afterFailedRun: "continue", retry: { maxRetries: 3 } },
            now,
            ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
        },
        context
    );

    opened = harness;

    const desk = await harness.root(context);

    // A run a stopped process left is picked up where it stopped.
    harness.resume();

    /**
     * In one commit of the desk: the conversation with a person (made, with the person, the first time), the time
     * they spoke, and their consolidation task, started when none runs.
     */
    const touch = async (personId: string, name: string, said: SayOptions): Promise<ConversationId> =>
        desk.commit(async (tx) => {
            const state = await tx.doc(Network);
            let person = state.people[personId];

            if (person === undefined) {
                const made = await tx.createConversation({ ownership: { kind: "ownerless" } });

                await configure(tx, made.id, {
                    model: options.model,
                    instructions: "Follow the persona and the sections above.",
                    maxTurns: 20,
                });

                state.people[personId] = { id: personId, name, conversationId: made.id, lastSaidAt: now() };
                state.conversations[String(made.id)] = personId;
                // Read back through the draft: a change to the plain object assigned above would not be stored.
                person = state.people[personId]!;
            }

            person.lastSaidAt = now();
            if (said.email !== undefined) person.email = said.email;

            const running = await tx.doc(Consolidations, personId, null);

            if (running.taskId === null) {
                running.taskId = await tx.createTask(
                    consolidate,
                    { personId, conversationId: person.conversationId },
                    BACKGROUND
                );
            }

            return person.conversationId;
        }, context);

    return {
        harness,
        /** A person says something to ego. Answers ego's reply. */
        say: async (personId: string, name: string, text: string, said: SayOptions = {}): Promise<string> => {
            if (said.email !== undefined && !EMAIL.test(said.email)) throw new Error(`Not an email address: ${said.email}`);
            const conversation = (await harness.conversation(await touch(personId, name, said), context))!;
            const submission = await conversation.submit({ type: "input", content: text }, context);
            const settled = await submission.wait(context);

            if (settled.status !== "done") return `(no answer: ${settled.reason})`;
            if (settled.type !== "input") return "";

            const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);

            return textOf(entry?.model?.[0]?.content).trim();
        },
        /** Every message of the outbox, oldest first, with its delivery status. */
        outbox: () => outbox.list(context),
        /** The network as it is now. */
        network: () => harness.snapshot(Network, context),
        /** What ego remembers about a person: the facts about them, and the episodes of their conversation. */
        memory: async (personId: string) => ({
            facts: (await harness.snapshot(Facts, personId, context))?.facts ?? [],
            episodes: (await harness.snapshot(Episodes, personId, context))?.episodes ?? [],
        }),
        close: () => harness.close(context),
    };
};

export type Ego = Awaited<ReturnType<typeof openEgo>>;
