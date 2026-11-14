// The outbox: what ego sends to people outside a conversation (today: the emails of a made intro), and the durable
// task that delivers each message.
//
//   answer_intro ─► one commit: intro made + outbox message per person + a deliver task each
//
//   deliver ── attempt: attempts + 1 (stored) ─► call: sender.send(message, key = message id) ─► sent (stored)
//                                                   │ retryable error, attempts left: sleep (backoff) ─► attempt
//                                                   └ permanent error, or none left: failed (stored, with the reason)
//
// "Store what you are about to do, do it, store the result": a crash between the send and its "sent" calls the sender
// again with the same key. A sender must therefore pass the key on as the provider's idempotency key, so the
// provider keeps one delivery. A provider without one may deliver twice in that window, and only then.
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineTask, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Network } from "./network.ts";

/** A message to one person, as stored. A type, not an interface: a document's value must be JSON. */
export type OutboxMessage = {
    id: string;
    /** The person it goes to; their address is looked up when it is sent. */
    to: string;
    channel: "email";
    subject: string;
    body: string;
    createdAt: number;
};

export type Delivery = {
    message: OutboxMessage;
    status: "queued" | "sent" | "failed";
    attempts: number;
    lastError?: string;
    sentAt?: number;
    /** The provider's id of the delivery. */
    providerId?: string;
};

/** One document per message, keyed by its id. */
export const Outbox = defineDocFamily<Delivery | { message: null }, null>({
    kind: "ego.outbox",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ message: null }),
    checkpointWhen: () => false,
});

/** The ids of all messages, oldest first, to list them. */
export const OutboxIndex = defineDoc<{ ids: Array<string> }>({
    kind: "ego.outbox-index",
    version: 1,
    scope: "session",
    initial: () => ({ ids: [] }),
    checkpointWhen: () => false,
});

/** Where a message goes, resolved from the person when it is sent. */
export type Address = { email: string; name: string };

/** A channel's adapter. `key` must reach the provider as its idempotency key. */
export interface Sender {
    send(message: OutboxMessage, to: Address, key: string, signal: AbortSignal): Promise<{ id: string }>;
}

/** A failure that sending again will not fix (a refused address, a malformed message). */
export class PermanentSendError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PermanentSendError";
    }
}

export interface OutboxOptions {
    readonly harness: () => Harness;
    readonly sender: Sender;
    readonly now: () => number;
    /** Tries before a message fails. Default 6. */
    readonly maxAttempts?: number;
    /** The first backoff; it doubles each try, up to an hour. Default 30 s. */
    readonly backoffMs?: number;
}

type DeliverState = { phase: "attempt" } | { phase: "call" };

const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

const isDelivery = (doc: Delivery | { message: null }): doc is Delivery => doc.message !== null;

export const createOutbox = (options: OutboxOptions) => {
    const maxAttempts = options.maxAttempts ?? 6;
    const backoffMs = options.backoffMs ?? 30_000;

    const deliver = defineTask<{ messageId: string }, DeliverState, { status: "sent" | "failed" }>({
        name: "ego.deliver",
        version: 1,
        initial: () => ({ phase: "attempt" }),
        phases: {
            attempt: async (task, runtime, context) => {
                await runtime.commit(async (tx) => {
                    const doc = await tx.doc(Outbox, task.input.messageId, null);
                    if (!isDelivery(doc)) {
                        return { status: "terminal", outcome: { status: "failed", error: { message: `No message ${task.input.messageId}` } } };
                    }
                    if (doc.status !== "queued") {
                        return { status: "terminal", outcome: { status: "completed", result: { status: doc.status } } };
                    }
                    doc.attempts += 1;
                    return { status: "running", checkpoint: { phase: "call" } };
                }, context);
            },
            call: async (task, runtime, context) => {
                const harness = options.harness();
                const doc = await harness.snapshot(Outbox, task.input.messageId, context);
                if (doc === undefined || !isDelivery(doc)) throw new Error(`No message ${task.input.messageId}`);
                const message = doc.message;
                const person = (await harness.snapshot(Network, context))?.people[message.to];

                let outcome: { sent: { id: string } } | { error: string; permanent: boolean };
                if (person?.email === undefined) {
                    outcome = { error: `${message.to} has no email address`, permanent: true };
                } else {
                    try {
                        outcome = {
                            sent: await options.sender.send(message, { email: person.email, name: person.name }, message.id, runtime.signal),
                        };
                    } catch (error) {
                        // Closing or aborting the Harness: not the provider's answer. The phase reruns on resume.
                        if (runtime.signal.aborted) throw error;
                        outcome = { error: error instanceof Error ? error.message : String(error), permanent: error instanceof PermanentSendError };
                    }
                }

                await runtime.commit(async (tx) => {
                    const stored = await tx.doc(Outbox, message.id, null);
                    if (!isDelivery(stored)) return undefined;
                    if ("sent" in outcome) {
                        stored.status = "sent";
                        stored.sentAt = options.now();
                        stored.providerId = outcome.sent.id;
                        delete stored.lastError;
                        return { status: "terminal", outcome: { status: "completed", result: { status: "sent" } } };
                    }
                    stored.lastError = outcome.error;
                    if (outcome.permanent || stored.attempts >= maxAttempts) {
                        stored.status = "failed";
                        return { status: "terminal", outcome: { status: "completed", result: { status: "failed" } } };
                    }
                    const delay = Math.min(60 * 60 * 1000, backoffMs * 2 ** (stored.attempts - 1));
                    return { status: "sleeping", until: options.now() + delay, checkpoint: { phase: "attempt" } };
                }, context);
            },
        },
        abort: async (_task, runtime, context) => {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
        },
    });

    /**
     * Inside a commit: store `message` and start its delivery, unless a message with its id exists already (the same
     * intro made twice stores and sends nothing twice). Answers whether it was new.
     */
    const enqueue = async (tx: Tx, message: Omit<OutboxMessage, "createdAt">): Promise<boolean> => {
        const doc = await tx.doc(Outbox, message.id, null);
        if (isDelivery(doc)) return false;
        Object.assign(doc, { message: { ...message, createdAt: options.now() }, status: "queued", attempts: 0 } satisfies Delivery);
        (await tx.doc(OutboxIndex)).ids.push(message.id);
        await tx.createTask(deliver, { messageId: message.id }, BACKGROUND);
        return true;
    };

    /** Every message, oldest first. */
    const list = async (context: Context): Promise<ReadonlyArray<Delivery>> => {
        const harness = options.harness();
        const ids = (await harness.snapshot(OutboxIndex, context))?.ids ?? [];
        const docs = await Promise.all(ids.map((id) => harness.snapshot(Outbox, id, context)));
        return docs.flatMap((doc) => (doc !== undefined && isDelivery(doc) ? [doc] : []));
    };

    return { deliver, enqueue, list };
};

export type OutboxHandle = ReturnType<typeof createOutbox>;

/** The CLI's sender: prints the email instead of sending it. */
export const consoleSender = (write: (text: string) => void = console.log): Sender => ({
    send: async (message, to, key) => {
        write(`\n--- email ${key} to ${to.name} <${to.email}>\nSubject: ${message.subject}\n\n${message.body}\n---`);
        return { id: `console:${key}` };
    },
});
