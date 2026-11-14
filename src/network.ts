// The network: everyone ego has talked to, and the intros between them. One session document of the Harness, so it is
// committed together with the transcript and survives a restart. What ego knows about each person is in `memory.ts`.
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";

/** A person, as ego knows them. A type, not an interface: a document's value must be JSON. What ego knows about them
 * is in their facts (`memory.ts`). */
export type Person = {
    id: string;
    name: string;
    /** This person's one conversation with ego. */
    conversationId: ConversationId;
    /** When they last said something: the consolidation task waits until they have been quiet for a while. */
    lastSaidAt: number;
    /** Where the outbox reaches them; given by the channel they came from (`say`'s options). */
    email?: string;
};

/** Whether a side of an intro said yes, no, or has not been asked yet. */
export type Consent = "yes" | "no" | "pending";

/** A double opt-in intro: made only when both sides say yes. */
export type Intro = {
    id: string;
    /** The person ego proposed the intro to first (who asked, or who it is for). */
    from: string;
    /** The person on the other side. */
    to: string;
    /** Why ego thinks these two should meet; shown to the other side when asked. */
    reason: string;
    consent: { from: Consent; to: Consent };
    status: "pending" | "made" | "declined";
    at: number;
};

export type NetworkState = {
    people: Record<string, Person>;
    intros: Array<Intro>;
    /** Which person each conversation of the Harness is with, by `String(conversationId)`. */
    conversations: Record<string, string>;
};

export const Network = defineDoc<NetworkState>({
    kind: "ego.network",
    version: 1,
    scope: "session",
    initial: () => ({ people: {}, intros: [], conversations: {} }),
    checkpointWhen: () => false,
});

/** The intros that wait for `personId`'s answer. */
export const awaiting = (
    state: Readonly<NetworkState>,
    personId: string
): ReadonlyArray<Intro> =>
    state.intros.filter(
        (intro) =>
            intro.status === "pending" &&
            ((intro.from === personId && intro.consent.from === "pending") ||
                (intro.to === personId && intro.consent.to === "pending"))
    );
