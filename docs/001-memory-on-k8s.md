# 001 — Memory that survives a Kubernetes pod

Status: 2026-11-14.
- **Built:** build order steps 1–2: facts, visibility, `remember`/`recall`, the profile, and the consolidation task. Also the CockroachDB storage of section 3.
- **Different from this proposal:**
  - The profile is rendered from facts on every request, not rebuilt by a model.
  - Consolidation writes episodes only; facts are written live by `remember`.
  - Embeddings (`ego_vectors`) are not built: v1 search is keyword matching.

**Goal.** A pod can be killed at any moment (rolling update, node drain, OOM, eviction), and the new pod picks up
exactly where the old one stopped. No memory is lost, no conversation is answered twice, no intro is sent twice.

**Assumption.** Ego may remember what people say about *other* people. Such a fact is `matchable`: matching uses it,
but Ego never quotes it. If we choose "self-reported only", layer 2 loses its `about ≠ source` case; nothing else
changes.

---

## 1. Constraints from pi-durable (verified in its README)

1. Storage is SQLite (one file, WAL, `synchronous=NORMAL`), JSONL, IndexedDB or a Cloudflare Durable Object. There
   is **no Postgres backend**.
2. **One process owns a storage at a time; there is no cross-process locking.** Two pods on one file corrupt it.
3. A commit is stored before anything is shown. On reopen, `harness.resume()` continues every unfinished task. A
   model request cut off counts as a failed attempt and is retried. A tool reruns only if it is `replay: "safe"`.
4. `submit({ requestId })` is deduplicated: the same id returns the same submission.
5. Durable sleeps (task timers) survive restarts.

Everything below follows from these five facts.

## 2. Memory model

All four layers live in **one SQLite file owned by one pod**. The source of truth is pi-durable documents and
entries. Anything else is derived and can be rebuilt.

| Layer | What | Stored as | Loaded | Written by |
|---|---|---|---|---|
| 1. Profile | ≤ 300-word summary: who, wants now, offers, preferences, `confirmedAt` per section | `ego.profile` doc family, key = personId | Always, as a section | Consolidation task only (rebuilt from facts) |
| 2. Facts | Atomic statements: `{id, about, source, text, kind, visibility, at, confirmedAt, supersedes?, retired?}` | `ego.facts` doc family, key = personId (about) | Matching; `recall` | `remember` tool (live) + consolidation |
| 3. Episodes | One paragraph per conversation burst, dated | `ego.episodes` doc family, key = personId | `recall(query)` | Consolidation task |
| 4. Transcripts | Every message | pi-durable entries (exists) | `recall` can open the source conversation | pi-durable |
| Derived | Embeddings of facts and episodes | Host table `ego_vectors` in the **same file** (prefix `pi_` for pi's tables), or rebuilt on boot | `recall`, `search_people` | After each consolidation; rebuilt if missing |

**Visibility** on every fact:
- `private`: shown only in the conversation with `source`.
- `matchable`: used for scoring and search, never quoted, never attributed.
- `shareable`: may be told to the other side of a proposed intro.

**The rule is enforced in code, not the prompt.** The section and the tools filter facts by the conversation's
person before the model sees anything. A test asserts that a `private` fact from Alice never appears in Bob's
context.

**Freshness.** A fact of kind `goal` or `status` older than 90 days since `confirmedAt` shows in the profile as
"(unconfirmed since …)". The persona tells Ego to re-ask before acting on it.

**Contradictions.** `remember` with `supersedes: <factId>` retires the old fact (`retired: true`). The old fact is
kept, because history is cheap and undo matters.

### Consolidation: a durable task, not a timer of the process

```
person speaks ──► conversation run ──► (live) remember(fact) tool commits facts
                       │
                       └─ commit also (re)arms task "consolidate:<personId>":  sleep 10 min idle
                                                                   │  (durable sleep: survives pod restart)
                                                                   ▼
                       cheap model reads new entries since `consolidatedThrough`
                       → writes episode, adds/retires facts, rebuilds profile
                       → advances `consolidatedThrough` (same commit)
                       → re-embeds changed facts/episodes (replay-safe, idempotent by content hash)
```

- One task per person. It is re-armed (not duplicated) through a `Work` doc keyed `consolidate:<personId>`, the
  same pattern as the per-person conversation docs.
- `consolidatedThrough` (an entry id) makes it **idempotent**. A pod killed mid-consolidation reruns from the
  same point and gets the same input.
- Each step is a stored step of the task. A rerun does not call the model again for a step that is already stored.

## 3. Kubernetes layout

> **Update 2026-11-14: CockroachDB is built** (`../pi-durable-cockroach`, `EGO_STORAGE=cockroach`). With it, ego
> runs as a **Deployment, no PVC and no Litestream**. Each pod claims the lease of one schema (`EGO_SCHEMA`), and
> the lease's fence replaces the flock below. One pod per schema; more schemas mean more pods. The SQLite layout
> below stays valid for `EGO_STORAGE=sqlite`.

```
                Ingress / webhooks (WhatsApp, email, chat)
                               │
                       Service ego (ClusterIP)
                               │
            StatefulSet ego, replicas: 1, podManagementPolicy: OrderedReady
            ┌────────────────────────────────────────────────────────┐
            │ initContainer: litestream restore (if db missing)       │
            │ container ego   ── /data/ego.db (PVC, RWO)              │
            │ sidecar litestream replicate ──► S3/GCS bucket          │
            └────────────────────────────────────────────────────────┘
```

Why each choice:

| Choice | Because |
|---|---|
| **StatefulSet, replicas 1** (not a Deployment) | A Deployment's rolling update starts the new pod before the old one stops, so two writers share one file. A StatefulSet stops the old pod first. A Deployment with `strategy: Recreate` also works. |
| **PVC, ReadWriteOnce** | The file survives pod restarts on the same volume. RWO lets only one node mount it. |
| **Litestream sidecar → bucket** | Survives losing the volume, zone or cluster. The init container restores on an empty volume. |
| **Lease as a fence** | Belt and braces against two writers (e.g. a stuck node that is still running). On boot, acquire a `coordination.k8s.io/Lease` named `ego-writer`, or an exclusive `flock` on `/data/ego.lock`, before `Harness.open`. If it is not acquired, exit. |
| **terminationGracePeriodSeconds: 60** | On SIGTERM: readiness goes false → stop accepting input → `harness.close()` (it finishes the commit in flight) → exit. Anything unfinished resumes on the next pod. |
| **Probes** | liveness = event loop alive; readiness = Harness open, lease held, not shutting down. |

### Inbound messages: never lose, never double

- A webhook handler calls `conversation.submit({ type: "input", content, requestId: <provider message id> })` and
  **returns 200 only after the submit is committed**. If the pod dies before that, the provider retries. If it
  dies after, the retry is deduplicated by `requestId`.
- The reply is not sent inside the run. The run commits it to an **outbox doc**. A durable `deliver` task sends it
  with the provider's idempotency key (or our `outboxId`) and marks it sent in the same task's next step. If the
  pod dies between sending and marking, the resend is deduplicated by the provider key. Where a provider has no
  key, we accept rare duplicates and log them.
- Made intros are emails sent through the same outbox, so an intro is never sent twice.

### Boot sequence

```
1. (init) litestream restore -if-db-not-exists -if-replica-exists /data/ego.db
2. acquire lease / flock  ── fail → exit 1 (k8s restarts; old holder still alive)
3. Harness.open(openNodeSqliteStorage("/data/ego.db"))
4. ensure derived: if ego_vectors is missing or stale → rebuild from facts/episodes (background)
5. harness.resume()   ── continues: runs, consolidations (their sleeps), outbox deliveries
6. readiness = true
```

## 4. How far one pod goes, and the path beyond

A single Node process is I/O-bound on model calls. It handles thousands of concurrent conversations. SQLite in WAL
handles thousands of commits per second. Run one pod until the metrics say otherwise.

When it is not enough, **shard by person**: N StatefulSet pods, each owning `ego-<n>.db` for
`hash(personId) % N`. The catch is that matching needs everyone. Then the network index (people, matchable
facts, vectors) moves to a shared store that each shard writes **derived** copies into: Postgres + pgvector, fed
from each shard's outbox. Each shard stays the source of truth for its own people. Cross-shard intros become
messages between shards, delivered through the outbox. This is a real redesign. Do not start here.

## 5. Build order

1. Facts, visibility, and `remember`/`recall` with keyword search; the profile section built from facts; the
   privacy test.
2. The consolidation durable task (idle sleep, `consolidatedThrough`) and tests with a fake timer, including "kill
   mid-consolidation, reopen, the same result".
3. Lease/flock fence, SIGTERM handling, health endpoints, and an HTTP `/say` endpoint with `requestId`.
4. Dockerfile, StatefulSet + PVC + Litestream manifests (kind/minikube smoke test: `kubectl delete pod` mid-run →
   the run finishes on the new pod).
5. Outbox + deliver task (email first).
6. Embeddings (`ego_vectors`), then a reranker for `search_people`.

## 6. Tests that prove "it proceeds"

- Reopen the same SQLite file mid-run (model call in flight): the answer arrives once.
- Kill during consolidation: after reopen, exactly one episode and the same facts.
- A duplicate webhook (same `requestId`): one user entry, one reply.
- Two processes on one file: the second exits on the fence.
- A private fact from Alice is absent from Bob's whole context (sections + tool results).
