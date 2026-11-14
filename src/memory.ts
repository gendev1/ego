// ego's memory, v1 (design: docs/001-memory-on-k8s.md, section 2). Everything is a pi-durable document, so it is
// committed with the transcript and lives wherever the Harness's storage lives (SQLite or CockroachDB).
//
//   facts    ego.facts    family, key = the person a fact is ABOUT   written live by `remember`
//   episodes ego.episodes family, key = the person a conversation is WITH   written by the consolidation task
//   profile  derived on every request from the facts (no model, never stale with respect to them)
//
// Who may see a fact is decided here, in code, before the model sees anything:
//   private    only in conversations with its source
//   matchable  scored by search_people, never shown to anyone but its source, never attributed
//   shareable  its text may be shown to others (search results, intros)
// In a person's own conversation, Ego sees only what that person said (about themselves or about others), never
// what others said about them.
import { defineDocFamily } from "@earendil-works/pi-durable";

export const VISIBILITIES = ["private", "matchable", "shareable"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const FACT_KINDS = ["role", "goal", "offer", "preference", "status", "other"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** A type, not an interface: a document's value must be JSON. */
export type Fact = {
    id: string;
    /** The person the fact is about. */
    about: string;
    /** The person who said it: always the person of the conversation it was remembered in, set by code. */
    source: string;
    text: string;
    kind: FactKind;
    visibility: Visibility;
    at: number;
    /** When the fact was last said or confirmed. */
    confirmedAt: number;
    /** The fact this one replaced. */
    supersedes?: string;
    /** Retired: superseded or retracted. Kept for history, never shown. */
    retired?: boolean;
};

export type Episode = {
    id: string;
    at: number;
    /** A few sentences on one stretch of a conversation. */
    summary: string;
    /** The last entry of the conversation this episode covers. */
    through: number;
};

export const Facts = defineDocFamily<{ facts: Array<Fact> }, null>({
    kind: "ego.facts",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ facts: [] }),
    checkpointWhen: () => false,
});

export const Episodes = defineDocFamily<{ episodes: Array<Episode>; consolidatedThrough: number }, null>({
    kind: "ego.episodes",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ episodes: [], consolidatedThrough: 0 }),
    checkpointWhen: () => false,
});

/** Goals and statuses are re-asked about after this long without a confirmation. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const live = (facts: ReadonlyArray<Fact>) => facts.filter((fact) => fact.retired !== true);

/** The facts about `about` that `viewer` may read as text: theirs, and the shareable ones of others. */
export const readableBy = (facts: ReadonlyArray<Fact>, viewer: string): ReadonlyArray<Fact> =>
    live(facts).filter((fact) => fact.source === viewer || fact.visibility === "shareable");

/** The facts about `about` that matching may score for someone else: never the private ones. */
export const matchableFacts = (facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
    live(facts).filter((fact) => fact.visibility !== "private");

const isStale = (fact: Fact, now: number) =>
    (fact.kind === "goal" || fact.kind === "status") && now - fact.confirmedAt > STALE_AFTER_MS;

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The profile of `person` in their own conversation: what they told Ego about themselves, by kind, with ids so Ego
 * can supersede or confirm a fact. Others' facts about them are not shown here.
 */
export const renderProfile = (facts: ReadonlyArray<Fact>, person: string, now: number): string => {
    const own = live(facts).filter((fact) => fact.source === person && fact.about === person);
    if (own.length === 0) return "(nothing yet: you have not learned anything about them)";

    return FACT_KINDS.flatMap((kind) => {
        const ofKind = own.filter((fact) => fact.kind === kind);
        if (ofKind.length === 0) return [];
        return [
            `${kind}:`,
            ...ofKind.map(
                (fact) =>
                    `- [${fact.id}] ${fact.text}${isStale(fact, now) ? ` (unconfirmed since ${day(fact.confirmedAt)}: re-ask before acting on it)` : ""}${fact.visibility === "shareable" ? "" : ` (${fact.visibility})`}`,
            ),
        ];
    }).join("\n");
};

/** The words of a text, for keyword matching (v1; embeddings are v2). */
export const words = (text: string): Set<string> =>
    new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length > 2),
    );

/** How many of `query`'s words `text` has. */
export const score = (query: Set<string>, text: string): number => {
    const have = words(text);
    return [...query].filter((word) => have.has(word)).length;
};
