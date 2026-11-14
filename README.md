# ego

A bare-bones Boardy-style connector agent on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Text only, no voice.

- **One agent, one memory.** Everyone talks to the same Ego. It works for the goodwill of the whole network, not for one user (`src/prompts.ts`).
- **Memory v1** (`src/memory.ts`, design in `docs/001-memory-on-k8s.md`):
  - **Facts.** The model saves one fact at a time with `remember`, and can update one (`supersedes`), `confirm_fact` it or `retract_fact` it. Each fact records who it's about and who said it; the source is always the person in the conversation, set by code.
  - **Visibility, enforced in code:** `private` facts are used only with the person who said them. `matchable` facts guide `search_people` but are never shown or attributed. Only `shareable` text is shown to others. In their own conversation, a person sees only what they themselves told Ego.
  - **The profile** is built from the person's own facts on every request. Goals and statuses unconfirmed for 90 days are flagged for re-asking.
  - **Episodes.** After a person has been quiet for 10 minutes, a durable background task summarizes the new part of their conversation (`EGO_MEMORY_MODEL`, default `claude-haiku-5-5`). Its sleep survives a restart. `recall` searches the episodes and what the person said.
  - Search is keyword matching in v1; embeddings are v2.
- **Outbox.** When an intro is made, each side gets an email introducing the other. The messages and their delivery tasks are stored in the same commit that marks the intro made.
  - The `deliver` task saves each attempt before calling the sender, and passes the message id as the provider's idempotency key, so a crash mid-send doesn't produce two deliveries.
  - Retryable errors back off with a durable sleep (30 s, doubling, up to 6 tries). `PermanentSendError`, or a person with no email address, fails the message with its reason.
  - The CLI's sender prints the email. A real provider is a `Sender` that passes `key` through as its idempotency key.
- **Double opt-in intros.** `search_people` → `propose_intro` → the other side is asked on their next talk → `answer_intro`. Details are shared only when both say yes.
- **Durable.** Transcripts, tool calls and the network document live in one storage, chosen by `EGO_STORAGE` (`src/storage.ts`). A run cut off by a crash resumes on the next start.
  - `sqlite` (default): one file, `state/ego.db`.
  - `cockroach`: one schema (`EGO_SCHEMA`, default `ego_0`) in `COCKROACH_URL`, through the optional dependency `pi-durable-cockroach`. A lease lets one process own it at a time, so pods keep nothing on disk. That package isn't published yet: until it is, a clone of this repo runs on `sqlite` (or `memory`), and the CockroachDB tests need it checked out next to `ego`.

```
say(person, text) ─► desk.commit: person + their conversation ─► submit ─► model + tools ─► answer
                                   network doc (people, intros) ◄── tools commit here
```

| File | What |
|---|---|
| `src/agent.ts` | Harness, one conversation per person, `say()` |
| `src/tools.ts` | Sections (persona, profile, waiting intros) and the tools: `remember`, `confirm_fact`, `retract_fact`, `recall`, `search_people`, `propose_intro`, `answer_intro` |
| `src/memory.ts` | Facts, episodes, visibility rules, profile rendering |
| `src/consolidate.ts` | The durable task that writes episodes when a person goes quiet |
| `src/outbox.ts` | The outbox and its durable `deliver` task; the `Sender` interface and the console sender |
| `src/network.ts` | People and intros |
| `src/storage.ts` | `EGO_STORAGE`: sqlite, cockroach or memory |
| `src/prompts.ts` | The persona |
| `src/models.ts` | Anthropic via `ANTHROPIC_API_KEY`, model from `EGO_MODEL` (default `claude-sonnet-5-5`) |
| `src/cli.ts` | Terminal chat; `/as <id> <name>` to play several people, `/network` and `/memory [id]` to inspect |

```bash
npm install
npm run check                       # typecheck + tests (pi-ai faux model, no key needed)
npm run test:cockroach              # the same tests on CockroachDB (cd ../pi-durable-cockroach && npm run db:up)
ANTHROPIC_API_KEY=... npm run chat
EGO_STORAGE=cockroach COCKROACH_URL='postgresql://root@localhost:26257/defaultdb?sslmode=disable' npm run chat
```

Next steps toward Boardy: embeddings + a reranker in `searchPeople`, email/WhatsApp channels as durable tasks that send the made intro, compaction, and voice.

## License

MIT, see [LICENSE](LICENSE).
