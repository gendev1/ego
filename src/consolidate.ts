// The consolidation task: after a person has been quiet for `idleMs`, summarize what is new in their conversation
// into an episode. A durable task, so its sleep and its progress survive a restart (and a pod that dies):
//
//   say() ─► desk.commit: lastSaidAt = now; no task for this person yet? create one
//
//   wait ── sleepUntil(lastSaidAt + idle) ─► check ── spoke again since? ─► wait
//                                              │ no
//                                              ▼
//                                          summarize ── model call (a cheap model) ─► one commit:
//                                              episode + consolidatedThrough + (more since? → wait : end, clear Work)
//
// The model call happens before the commit that stores its result, so a crash between them calls the model again
// and stores one episode: the input is the same entries after the same `consolidatedThrough`.
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
    defineDocFamily,
    defineTask,
    type ConversationId,
    type EntryId,
    type EntryRecord,
    type Harness,
    type ModelRef,
    type TaskId,
} from "@earendil-works/pi-durable";
import { Episodes } from "./memory.ts";
import { Network } from "./network.ts";

export type ConsolidateInput = { personId: string; conversationId: ConversationId };
type ConsolidateState = { phase: "wait" } | { phase: "check" } | { phase: "summarize" };

/** The consolidation task of each person while one runs: `say()` starts one only when there is none. */
export const Consolidations = defineDocFamily<{ taskId: TaskId | null }, null>({
    kind: "ego.consolidations",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ taskId: null }),
    checkpointWhen: () => false,
});

export interface ConsolidateOptions {
    readonly harness: () => Harness;
    readonly model: ModelRef;
    readonly idleMs: number;
    readonly now: () => number;
}

const SUMMARY_PROMPT = `You keep the memory of Ego, a super-connector. Summarize the conversation below between Ego
and one person in 2 to 4 sentences, for Ego to read before talking with them again: what they want now, what they
offered, what was decided, and which intros came up. Plain sentences, no preamble.`;

const MAX_ENTRIES = 400;

const textOf = (content: Message["content"]): string =>
    typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** The person's and Ego's words of `entries`, one line each; tool calls and results are left out. */
const transcriptOf = (entries: ReadonlyArray<EntryRecord>, name: string): string =>
    entries
        .flatMap((entry) => {
            const message = entry.model?.[0];
            if (message === undefined) return [];
            const who = message.role === "user" && entry.kind === "pi.user" ? name : message.role === "assistant" ? "Ego" : undefined;
            const text = who === undefined ? "" : textOf(message.content).trim();
            return who === undefined || text === "" ? [] : [`${who}: ${text}`];
        })
        .join("\n");

export const consolidateTask = (options: ConsolidateOptions) => {
    const entriesAfter = async (conversationId: ConversationId, after: number, context: Context) => {
        const conversation = await options.harness().conversation(conversationId, context);
        if (conversation === undefined) return [];
        return (await conversation.entries({ order: "ascending", minEntryId: (after + 1) as EntryId }, MAX_ENTRIES, undefined, context)).items;
    };

    return defineTask<ConsolidateInput, ConsolidateState, null>({
        name: "ego.consolidate",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
            wait: async (task, runtime, context) => {
                const state = await options.harness().snapshot(Network, context);
                const lastSaidAt = state?.people[task.input.personId]?.lastSaidAt ?? options.now();
                await runtime.sleepUntil(lastSaidAt + options.idleMs, { phase: "check" }, context);
            },
            check: async (task, runtime, context) => {
                const state = await options.harness().snapshot(Network, context);
                const lastSaidAt = state?.people[task.input.personId]?.lastSaidAt ?? 0;
                const quiet = options.now() >= lastSaidAt + options.idleMs;
                await runtime.commit(
                    () => ({ status: "running", checkpoint: quiet ? { phase: "summarize" } : { phase: "wait" } }),
                    context,
                );
            },
            summarize: async (task, runtime, context) => {
                const { personId, conversationId } = task.input;
                const memory = await options.harness().snapshot(Episodes, personId, context);
                const through = memory?.consolidatedThrough ?? 0;
                const entries = await entriesAfter(conversationId, through, context);
                const name = (await options.harness().snapshot(Network, context))?.people[personId]?.name ?? personId;
                const transcript = transcriptOf(entries, name);
                const last = entries.at(-1)?.id ?? through;

                let summary = "";

                if (transcript !== "") {
                    const model = runtime.models.getModel(options.model.provider, options.model.modelId);
                    if (model === undefined) throw new Error(`Unknown model ${options.model.provider}/${options.model.modelId}`);
                    const answer = await runtime.models.completeSimple(model, {
                        systemPrompt: SUMMARY_PROMPT,
                        messages: [{ role: "user", content: transcript, timestamp: options.now() }],
                    });
                    summary = textOf(answer.content).trim();
                }

                await runtime.commit(async (tx) => {
                    const doc = await tx.doc(Episodes, personId, null);

                    // Another run already stored this stretch (a crash after its commit): store nothing twice.
                    if (doc.consolidatedThrough >= last && last > through) return { status: "running", checkpoint: { phase: "wait" } };

                    if (summary !== "") {
                        doc.episodes.push({ id: `${personId}:e${doc.episodes.length + 1}`, at: options.now(), summary, through: last });
                    }
                    doc.consolidatedThrough = Math.max(doc.consolidatedThrough, last);

                    // They spoke again while the model wrote: go round once more instead of ending.
                    const lastSaidAt = (await tx.doc(Network)).people[personId]?.lastSaidAt ?? 0;
                    if (lastSaidAt + options.idleMs > options.now()) return { status: "running", checkpoint: { phase: "wait" } };

                    (await tx.doc(Consolidations, personId, null)).taskId = null;
                    return { status: "terminal", outcome: { status: "completed", result: null } };
                }, context);
            },
        },
        abort: async (task, runtime, context) => {
            await runtime.commit(async (tx) => {
                (await tx.doc(Consolidations, task.input.personId, null)).taskId = null;
                return { status: "terminal", outcome: { status: "aborted" } };
            }, context);
        },
    });
};
