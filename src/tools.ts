// ego's tools and the sections it sees before every request. The person a conversation is with comes from the
// network document, never from the model: a tool cannot act for someone else, and a fact's source is always that
// person. Who may see which fact is decided by `memory.ts`, before anything reaches the model.
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
    defineExtension,
    defineTool,
    section,
    type ConversationId,
    type AnyTask,
    type Tx,
} from "@earendil-works/pi-durable";
import {
    Episodes,
    FACT_KINDS,
    Facts,
    matchableFacts,
    readableBy,
    renderProfile,
    score,
    VISIBILITIES,
    words,
    type Fact,
} from "./memory.ts";
import { awaiting, Network, type NetworkState } from "./network.ts";
import type { OutboxHandle } from "./outbox.ts";
import { PERSONA } from "./prompts.ts";

/** A tool's answer to the model. */
const say = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

/** The person of a conversation, or undefined for one ego was not opened for. */
const personOf = (state: Readonly<NetworkState>, conversationId: ConversationId) => {
    const id = state.conversations[String(conversationId)];

    return id === undefined ? undefined : state.people[id];
};

const NOBODY = "This conversation is with nobody ego knows.";

/** One of this person's own facts, by id, or an error text. */
const ownFact = async (tx: Tx, source: string, factId: string): Promise<Fact | string> => {
    const about = factId.slice(0, factId.lastIndexOf(":"));
    const fact = (await tx.doc(Facts, about, null)).facts.find((one) => one.id === factId);

    if (fact === undefined || fact.retired === true) return `There is no fact ${factId}.`;
    if (fact.source !== source) return `Fact ${factId} is not one this person told you.`;

    return fact;
};

export const egoExtension = (now: () => number, outbox: OutboxHandle, tasks: ReadonlyArray<AnyTask> = []) =>
    defineExtension({
        name: "ego",
        tasks: [...tasks],
        sections: [
            section("persona", () => PERSONA, { tag: false }),
            // The profile is always in context, like Boardy's "sheet out of the drawer": built from the person's own
            // facts on every request.
            section("person", async (input, context) => {
                const state = await input.read.snapshot(Network, context);
                const person = state && personOf(state, input.conversationId);

                if (person === undefined) return undefined;

                const facts = (await input.read.snapshot(Facts, person.id, context))?.facts ?? [];

                return `You are talking with ${person.name} (id ${person.id}). What they told you about themselves:\n${renderProfile(facts, person.id, now())}`;
            }),
            section("intros", async (input, context) => {
                const state = await input.read.snapshot(Network, context);
                const person = state && personOf(state, input.conversationId);

                if (state === undefined || person === undefined) return undefined;

                const waiting = awaiting(state, person.id);

                if (waiting.length === 0) return undefined;

                return [
                    "Intros waiting for this person's answer:",
                    ...waiting.map((intro) => {
                        const other = state.people[intro.from === person.id ? intro.to : intro.from];

                        return `- ${intro.id}: meet ${other?.name ?? "someone"}. Why: ${intro.reason}`;
                    }),
                ].join("\n");
            }),
        ],
        tools: [
            defineTool({
                name: "remember",
                description: [
                    "Remember one fact the person you are talking with just told you, in a short sentence. Call it once per fact.",
                    "about: the id of the person it is about (from search_people); leave it out for the person you are talking with.",
                    "visibility: shareable (fine to tell others, e.g. their role), matchable (use it to find matches, never repeat it), private (only for talking with this person).",
                    "supersedes: the id of a fact this one replaces (a changed goal, a new job).",
                ].join(" "),
                parameters: obj({
                    text: str(),
                    kind: oneOf(FACT_KINDS),
                    visibility: oneOf(VISIBILITIES),
                    about: opt(str()),
                    supersedes: opt(str()),
                }),
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const state = await tx.doc(Network);
                        const person = personOf(state, api.conversationId);

                        if (person === undefined) return say(NOBODY, true);

                        const about = args.about ?? person.id;

                        if (state.people[about] === undefined) return say(`There is nobody with id ${about}.`, true);

                        if (args.supersedes !== undefined) {
                            const old = await ownFact(tx, person.id, args.supersedes);

                            if (typeof old === "string") return say(old, true);

                            old.retired = true;
                        }

                        const doc = await tx.doc(Facts, about, null);
                        const id = `${about}:${doc.facts.length + 1}`;

                        doc.facts.push({
                            id,
                            about,
                            source: person.id,
                            text: args.text,
                            kind: args.kind,
                            visibility: args.visibility,
                            at: now(),
                            confirmedAt: now(),
                            ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
                        });

                        return say(`Remembered as ${id}.`);
                    }, context),
            }),
            defineTool({
                name: "confirm_fact",
                description: "Mark one of this person's facts as still true, after they confirmed it.",
                parameters: obj({ factId: str() }),
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const person = personOf(await tx.doc(Network), api.conversationId);

                        if (person === undefined) return say(NOBODY, true);

                        const fact = await ownFact(tx, person.id, args.factId);

                        if (typeof fact === "string") return say(fact, true);

                        fact.confirmedAt = now();

                        return say("Confirmed.");
                    }, context),
            }),
            defineTool({
                name: "retract_fact",
                description: "Forget one of this person's facts: it was wrong, or they asked you to forget it.",
                parameters: obj({ factId: str() }),
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const person = personOf(await tx.doc(Network), api.conversationId);

                        if (person === undefined) return say(NOBODY, true);

                        const fact = await ownFact(tx, person.id, args.factId);

                        if (typeof fact === "string") return say(fact, true);

                        fact.retired = true;

                        return say("Forgotten.");
                    }, context),
            }),
            defineTool({
                name: "recall",
                description:
                    "Search your memory of this person: summaries of your past conversations with them, and everything they told you (about themselves and about others). Use it when they refer to something from before.",
                parameters: obj({ query: str() }),
                replay: "safe",
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const state = await tx.doc(Network);
                        const person = personOf(state, api.conversationId);

                        if (person === undefined) return say(NOBODY, true);

                        const query = words(args.query);
                        const episodes = (await tx.doc(Episodes, person.id, null)).episodes
                            .map((episode) => ({ episode, hits: score(query, episode.summary) }))
                            .filter((hit) => hit.hits > 0)
                            .toSorted((one, other) => other.hits - one.hits || other.episode.at - one.episode.at)
                            .slice(0, 5)
                            .map(({ episode }) => ({ date: new Date(episode.at).toISOString().slice(0, 10), summary: episode.summary }));

                        // Only what this person said: their facts about anyone.
                        const told: Array<{ id: string; about: string; text: string }> = [];

                        for (const about of Object.keys(state.people)) {
                            for (const fact of (await tx.doc(Facts, about, null)).facts) {
                                if (fact.retired !== true && fact.source === person.id && score(query, fact.text) > 0) {
                                    told.push({ id: fact.id, about: state.people[about]!.name, text: fact.text });
                                }
                            }
                        }

                        if (episodes.length === 0 && told.length === 0) return say("Nothing in your memory matches.");

                        return say(JSON.stringify({ episodes, facts: told.slice(0, 10) }));
                    }, context),
            }),
            defineTool({
                name: "search_people",
                description:
                    "Search everyone else in your network by keywords: roles, industries, needs, skills. Answers the best matches with what you may say about them.",
                parameters: obj({ query: str() }),
                replay: "safe",
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const state = await tx.doc(Network);
                        const person = personOf(state, api.conversationId);

                        if (person === undefined) return say(NOBODY, true);

                        const query = words(args.query);
                        const hits: Array<{ id: string; name: string; known: string[]; score: number }> = [];

                        for (const other of Object.values(state.people)) {
                            if (other.id === person.id) continue;

                            const facts = (await tx.doc(Facts, other.id, null)).facts;
                            // Scored on everything matching may use; shown only what this person may read.
                            const points =
                                score(query, other.name) +
                                matchableFacts(facts).reduce((sum, fact) => sum + score(query, fact.text), 0);

                            if (points === 0) continue;

                            hits.push({
                                id: other.id,
                                name: other.name,
                                known: readableBy(facts, person.id).map((fact) => fact.text),
                                score: points,
                            });
                        }

                        const best = hits.toSorted((one, other) => other.score - one.score).slice(0, 5);

                        return say(
                            best.length === 0
                                ? "Nobody in the network matches yet."
                                : JSON.stringify(best.map(({ id, name, known }) => ({ id, name, known }))),
                        );
                    }, context),
            }),
            defineTool({
                name: "propose_intro",
                description:
                    "Propose an intro between the person you are talking with and someone in your network. Call it only after this person said yes to meeting them. The other side is asked the next time they talk to you. The reason is shown to the other side: say nothing in it that is not shareable.",
                parameters: obj({ personId: str(), reason: str() }),
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const state = await tx.doc(Network);
                        const person = personOf(state, api.conversationId);

                        if (person === undefined) return say(NOBODY, true);
                        if (state.people[args.personId] === undefined || args.personId === person.id)
                            return say(`There is nobody with id ${args.personId}.`, true);

                        const open = state.intros.find(
                            (intro) =>
                                intro.status !== "declined" &&
                                [intro.from, intro.to].includes(person.id) &&
                                [intro.from, intro.to].includes(args.personId)
                        );

                        if (open !== undefined) return say(`Intro ${open.id} already exists (${open.status}).`);

                        const id = `intro-${state.intros.length + 1}`;

                        state.intros.push({
                            id,
                            from: person.id,
                            to: args.personId,
                            reason: args.reason,
                            consent: { from: "yes", to: "pending" },
                            status: "pending",
                            at: now(),
                        });

                        return say(`Proposed ${id}. The other side will be asked.`);
                    }, context),
            }),
            defineTool({
                name: "answer_intro",
                description: "Record whether the person you are talking with wants an intro that waits for their answer.",
                parameters: obj({ introId: str(), accept: bool() }),
                execute: async (args, api, context) =>
                    api.commit(async (tx) => {
                        const state = await tx.doc(Network);
                        const person = personOf(state, api.conversationId);
                        const intro = state.intros.find((one) => one.id === args.introId);

                        if (person === undefined) return say(NOBODY, true);
                        if (intro === undefined || intro.status !== "pending")
                            return say(`There is no open intro ${args.introId}.`, true);

                        const side = intro.from === person.id ? "from" : intro.to === person.id ? "to" : undefined;

                        if (side === undefined) return say(`Intro ${args.introId} is not this person's.`, true);

                        intro.consent[side] = args.accept ? "yes" : "no";
                        intro.status =
                            intro.consent.from === "no" || intro.consent.to === "no"
                                ? "declined"
                                : intro.consent.from === "yes" && intro.consent.to === "yes"
                                  ? "made"
                                  : "pending";

                        // Made: each side gets an email introducing the other, in this same commit.
                        if (intro.status === "made") {
                            const from = state.people[intro.from]!;
                            const to = state.people[intro.to]!;

                            for (const [self, other] of [
                                [from, to],
                                [to, from],
                            ] as const) {
                                await outbox.enqueue(tx, {
                                    id: `${intro.id}:${self.id}`,
                                    to: self.id,
                                    channel: "email",
                                    subject: `Ego intro: ${from.name} and ${to.name}`,
                                    body: [
                                        `Hi ${self.name},`,
                                        "",
                                        `Meet ${other.name}${other.email === undefined ? "" : ` (${other.email})`}. You both said yes to this intro.`,
                                        `Why I think you should talk: ${intro.reason}`,
                                        "",
                                        "Ego",
                                    ].join("\n"),
                                });
                            }
                        }

                        return say(
                            intro.status === "made"
                                ? "Both said yes: the intro is made, and both get an email with each other's details."
                                : intro.status === "declined"
                                  ? "Declined. Nobody's details were shared."
                                  : "Recorded."
                        );
                    }, context),
            }),
        ],
    });
