# Proposal: Durable home-relay outbox

> **Status — Proposal, written 2026-07-05, re-reviewed against main 2026-07-06, not started.**
> The 2026-07-06 review re-verified every seam claim against post-unified-activity main (the
> activity merge changed notification *rendering* — `details` payloads, `formatChatPreview` — not
> the relay seams; the tag/coalesce facts below still hold) and confirmed no outbox code has
> landed. Expands the P1 roadmap row
> "Durable home-relay outbox" ([ROADMAP.md](ROADMAP.md)) into a full design. Follow-on to the
> 2026-07-04 async ACL fan-out (`apps/api/src/lib/drive/acl-propagation.ts`): that made one seam
> non-blocking but in-memory; this makes every cross-home push durable, ordered, and bounded.
> Deliberately the **third instance** of the house "durable rows + self-scheduled drain" pattern,
> after `lib/mount/upload-queue.ts` and `lib/mount/content-reindex-queue.ts`.

> **TLDR**: Cross-home pushes (`sendToHome` in `apps/api/src/lib/home/home-relay.ts`) currently
> deliver by opening the recipient's Home inline. Five independent fan-out sites re-invented the
> same loop with different (mostly wrong) semantics: awaited-sequential, unbounded-concurrent, or
> fire-and-forget — and none survives a crash. The outbox is one server-level SQLite table
> (`data/server/outbox.db`): `sendToHome` becomes a synchronous row insert plus a drain kick; a
> single self-scheduled drain loop delivers rows through **one global concurrency budget** for
> home-opens, with per-(target, fifoKey) FIFO, coalescing for state-replacement verbs, full-jitter
> retry/backoff, dead-lettering, drain-on-shutdown, and replay-on-boot. `HomeMessage` is already
> plain serializable data and the `switch` in `sendToHome` is already the flat verb registry — no
> new dispatch machinery is needed. In the sharded future the outbox **is** the message transport:
> the drain's deliver step is the only place that learns about remote shards
> (see [SCALABILITY.md](SCALABILITY.md)).

## Problem

Every place where one user's action must land in another user's Home goes through
`sendToHome(targetUserId, message)`, which calls `getHome(targetUserId)` — a cold Home open costs
~30 file descriptors and real I/O (six eagerly-opened WAL databases, `shared.db` included, plus
maildir watchers — the warm ceiling measured in `PROPOSAL_FD_BUDGET.md`). The relay itself is
fine; the callers are not. The 2026-07-04 seam audit (recorded in the roadmap row, re-verified
against source 2026-07-05 and again 2026-07-06 post-unified-activity) found five fan-out sites,
each with a different failure mode:

| Seam | File | Verified behaviour today |
|---|---|---|
| Drive ACL fan-out | `lib/drive/acl-propagation.ts` | Async since 2026-07-04: bounded (Semaphore 8), per-path FIFO promise chain, drain-on-shutdown. **In-memory only — a crash loses every queued delivery**; a failed delivery is logged and dropped (no retry). |
| Calendar share | `lib/calendar/share-propagation.ts` | `propagateCalendarShare` is **awaited on the share PUT** (`Calendar.setCalendarShares` path), sequential per target, one cold home open each. Failures logged and dropped. |
| Calendar invitations | `lib/calendar/invite-propagation.ts` | Call sites in `calendar.ts` are fire-and-forget (`.catch(console.error)`), but the loops are sequential and two racing propagations have **no ordering**: an `invitation-update` delivered before its `invitation` finds no linked event and is silently dropped (`receiveInvitationUpdate` returns on miss), after which the older create payload lands — the update never reapplies. A cancel racing a create can be resurrected the same way. |
| Chat mention + activity | `lib/chat/chat.ts` (`postMessage`) | Both notification loops are **awaited inside `postMessage`**, sequentially — every previous participant's cold home open adds latency to every message send. (The SSE relay `notifySharedUsers` is fire-and-forget and cheap: `broadcast` messages short-circuit in `sendToHome` when the target home isn't resident.) |
| Watcher notifications | `lib/drive/history.ts` (`FileHistory.notifyWatchers`) | Concurrent but **unbounded** `Promise.all`, awaited (via `fanOut` → `recordFileEvent`) on every drive mutation. This is the fd-burst class: a 26-home fan-out crashed the server with `SQLITE_IOERR_VNODE` under `ulimit -n 256`, silently skipping recipients. |
| Signup reconciliation | `lib/share/reconciliation.ts` | Sequential in the `user.create` hook and team-member add. Mostly `pull*` reads (can't ride a push queue); rare. Note only. |

Two corrections to the roadmap row that surfaced while grounding it: (1) chat's "coalesce-by-tag
makes ordering a non-issue" is true, but via the notification **tag upsert** in
`NotificationCenter.persist` (last write wins on a UNIQUE tag), not the `coalesce` flag — chat's
persist inputs carry tags but don't set `coalesce: true`; only `notifyWatchers` does. The flag only
suppresses SSE toast bursts. (2) Chat's cross-home cost is specifically the two notification
loops; the mention/activity claim in the row is otherwise accurate as written.

Common to all: **nothing survives a crash**, failures are logged-and-dropped rather than retried,
and each seam hand-rolls its own concurrency policy. The fix belongs in the relay, once — not per
seam.

## Goals / non-goals

**Goals**
- A crash or restart never loses an accepted cross-home delivery, where **accepted means
  enqueued**: rows are committed before the triggering request returns, and replay on boot.
  (The residual window between domain commit and enqueue is stated under Where rows persist.)
- Failed deliveries retry with backoff instead of being dropped; permanently failing rows
  dead-letter visibly instead of silently.
- One global concurrency budget for delivery-driven home-opens replaces every per-seam
  semaphore/`Promise.all`, closing the fd-burst class everywhere at once.
- Per-(target, fifoKey) FIFO where ordering is correctness (calendar invitations); coalescing
  where only the latest state matters (ACL, calendar shares, tagged notifications).
- The design is the sharding transport: serialized rows + a deliver step that can become an RPC,
  with no schema change.

**Non-goals**
- Queuing **pulls** or value-returning event mutations (`pull*`, `createEventAt`/`updateEventAt`/
  `deleteEventAt`, `pushUserProfile`). Reads need answers now; they stay synchronous in-process
  calls (RPC later, per SCALABILITY.md).
- Queuing `broadcast`. It is ephemeral SSE, already short-circuited in `sendToHome` when the
  target home isn't resident (`atHome`); replaying a stale UI-refresh event after a reboot is
  meaningless — clients refetch on reconnect. It stays a direct call.
- Queuing outbound email. `sendMail` (iMIP invites, share emails) keeps its own fire-and-forget
  transport at the seams; the outbox carries `HomeMessage` verbs only.
- Exactly-once delivery. At-least-once plus idempotent receivers (audited below) is sufficient
  and infinitely simpler.
- A generic job system. This is a table and a class, shaped like the two queues we already run.

## Current relay inventory (ground truth)

`home-relay.ts` today, verified verb by verb:

**Push** — `sendToHome(targetUserId, message)` with the `HomeMessage` discriminated union:
`drive:acl-change`, `calendar:share`, `calendar:invitation`, `calendar:invitation-update`,
`calendar:invitation-removal`, `calendar:rsvp`, `broadcast`, `notification`. Every payload is
plain data (SCALABILITY.md already relies on this: "Serialize HomeMessage (it's already plain
data)"). No closures, no live objects — some payloads carry `Date` fields (`DrivePath` timestamps,
invitation `startTime`/`endTime`), which is a JSON-serialization detail, not a redesign.

**Pull** — `pullSharedPaths`, `pullCalendarShares`, `pullPendingInvitations`,
`pullCalendarPermission`, `pullCalendars`, `pullCalendarById`, `pullEventsInRange`,
`pullTeamQuotaOverrides`, `pullTeamMounts`; plus the calendar event-mutation seam
(`createEventAt`, `updateEventAt`, `deleteEventAt`) and the home→server `pushUserProfile`. All
stay synchronous — out of scope.

The `switch` inside `sendToHome` is already the flat, named verb registry the outbox needs: one
serializable tag dispatching to a self-contained `receive*` method on the target home
(`Drive.receiveSharedPathChange`, `Calendar.receiveShare`/`receiveInvitation`/…,
`NotificationCenter.persist`). No `Record` of handlers, no plugin system — the discriminated-union
switch is the house pattern (same shape as the `sse-events.ts` builders) and it stays.

## Design

### The third queue instance

| | `UploadQueue` | `ContentReindexQueue` | **`HomeRelayOutbox`** |
|---|---|---|---|
| Durable state | `pending_uploads` rows in each mount's `metadata.db` + staged copies | `contentDirty` bit on `paths` | `outbox` rows in `data/server/outbox.db` |
| Instances | per mount | per mount | **one, server-level** |
| Kick | `enqueueStaged` | `kick()` on mark | `enqueue()` (from `sendToHome`) |
| Drain | one loop, coalescing concurrent calls, self-timer for backed-off rows, no global poller | same | same |
| Concurrency | per-destination semaphore (`getUploadSemaphore`) | serial per mount | **one global semaphore over home-opens** |
| Ordering | newest-wins PK upsert per `storageKey` | coalesced by the dirty bit | per-(target, fifoKey) FIFO + newest-wins coalesce per `coalesceKey` |
| Retry | full-jitter backoff, unbounded attempts | cap window, retries forever | full-jitter backoff, dead-letter after cap |
| Crash | rows replay on mount open | bit replays on mount open | rows replay on **server boot** |
| Shutdown | bounded flush via drain deadline | bounded await of in-flight | bounded flush before `shutdownAllHomes` |

Deviations from the exemplars, each justified: a single instance (deliveries target arbitrary
homes, so there is no per-mount owner — one queue, one budget); a batch of lane-heads dispatched
concurrently under the semaphore rather than `UploadQueue`'s serial in-loop await (a single
instance must get its parallelism inside the loop; `acl-propagation.ts` already uses exactly this
`Promise.all`-over-`semaphore.run` shape); and an attempt cap with dead-lettering (an upload's
bytes always exist so retrying forever is right; a delivery can fail permanently — deleted target
user — so retrying forever is wrong).

### Where rows persist

Three candidates were weighed:

- **(a) One server-level outbox DB** — replay-on-boot finds every row by opening one database;
  enqueue is possible from any context without touching the sender's Home; one place to count
  pending/dead for observability.
- **(b) Sender-side per-home table** — matches "rows move with the Home" and the sharding
  instinct, but replay-on-boot would need to open every home (hundreds of homes × ~30 fds — the
  exact burst this proposal exists to prevent) or accept that a crashed delivery waits until the
  *sender* next opens, which for a share can be days.
- **(c) A table in an existing per-home DB** (`shared.db`, `notifications.db`) — same replay
  problem as (b), plus neither DB's domain fits calendar verbs.

**Decision: (a), a new `data/server/outbox.db`.** The sharding objection to (a) dissolves on
inspection: in a multi-server deployment "server-wide" means **per API server**, and each server's
outbox holds messages sent *by homes resident on that server* — which is exactly the sender-side
ownership sharding wants, at server rather than home granularity. Home migration must drain the
mover's pending lanes before cutover, which migration already requires (SCALABILITY.md's "queue
messages until the new shard is ready"). This is the share-registry precedent: `eigen.db` is
already a server-level durable record of cross-home relationships written on the request path;
`lib/share/db.ts`'s `createAsyncSingleton` + `openLocalDatabase` pattern is copied verbatim. A
separate file (not a new table in `eigen.db`) keeps the high-write outbox out of the low-write
registry's WAL and makes the rollout purely additive — see Frozen-format.

Crash window: `enqueue()` is a synchronous SQLite insert, so **every queued verb commits its rows
before the triggering request returns** — uniformly, for all delivery-guarantee classes. The
enqueue-after-response question answers itself: an insert into one WAL database is cheap enough
that there is no verb for which deferring it buys anything. Seams that are fire-and-forget today
(invitations, RSVP) actually get *stronger*: today a crash right after the route returns loses
them entirely; with the outbox the rows already exist.

One residual window is stated honestly rather than hidden: the domain write and the outbox insert
always live in **different SQLite files**, and there is no cross-database transaction — a crash
between the domain commit and the enqueue loses that fan-out. In Phase 1 the window is not
microseconds: the awaited target resolution (`resolveACLUserIds`'s auth-db reads and registry
writes) sits between the ACL commit and the insert. Accepted, because the window is strictly
smaller than the status quo (which additionally loses everything already queued or in flight),
and closing it would take a staged-write redesign of every seam. Hence the definition above:
"accepted" means enqueued.

### Table and message shape

```sql
CREATE TABLE outbox (
    id            TEXT PRIMARY KEY,            -- uuid
    targetOwnerId TEXT NOT NULL,               -- receiving home (resolved user id)
    verb          TEXT NOT NULL,               -- HomeMessage['type'], minus 'broadcast'
    payload       TEXT NOT NULL,               -- JSON: the HomeMessage minus its type tag
    fifoKey       TEXT NOT NULL,               -- ordering lane within the target ('' = unordered)
    coalesceKey   TEXT,                        -- newest pending payload wins; NULL = never coalesce
    status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'dead'
    attempt       INTEGER NOT NULL DEFAULT 0,
    nextAttemptAt INTEGER NOT NULL,
    enqueuedAt    INTEGER NOT NULL,
    updatedAt     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_outbox_coalesce ON outbox(coalesceKey) WHERE coalesceKey IS NOT NULL;
CREATE INDEX idx_outbox_due  ON outbox(status, nextAttemptAt);
CREATE INDEX idx_outbox_lane ON outbox(targetOwnerId, fifoKey, enqueuedAt);
```

Payload serialization: `HomeMessage` payloads carry `Date` fields, so the JSON round-trip uses a
small date-tagging replacer/reviver pair exported from `home-relay.ts` — the project already
treats "dates survive the wire" as a convention (Eden's reviver, project-wide). This pair *is* the
future cross-server wire format; designing it now costs two functions.

Targets are **resolved user ids**, expanded at enqueue time — a share to a team inserts one row
per member, exactly as the seams resolve targets today. Membership changes after enqueue don't
retarget, matching current semantics.

Enqueue with a `coalesceKey` upserts on the partial unique index, replacing the pending payload
and resetting `attempt`/`nextAttemptAt` (UploadQueue's newest-staging-wins upsert, verbatim), and
keeps the original `enqueuedAt` so the row doesn't jump to the back of its lane. Every upsert
bumps `updatedAt` — that stamp is what makes the conditional ack below safe. An upsert that hits
a **dead** row (the unique index doesn't care about `status`) revives it: back to `pending` with
the fresh payload and `attempt = 0`, so a dead-lettered state-replacement verb heals itself on
the next change to the same key.

### Per-verb ordering and coalescing

| Verb | fifoKey | coalesceKey | Why |
|---|---|---|---|
| `drive:acl-change` | `path.id` | `{target}:acl:{path.id}` | Full-state replacement: only the latest ACL matters. Coalescing subsumes the per-path FIFO chain in `acl-propagation.ts` and is strictly better — intermediate states are never delivered, so the add→revoke resurrection hazard its comment describes can't occur (given the conditional ack below, which covers the upsert-during-delivery race). |
| `calendar:share` | `calendarId` | `{target}:calshare:{ownerId}:{calendarId}` | Same: `receiveShare`/`removeShare` carry full desired state. |
| `calendar:invitation` | `organizerEventId` | — | True FIFO with the update/removal verbs below — this is the create-vs-update hazard the roadmap row names. |
| `calendar:invitation-update` | `organizerEventId` | — | FIFO behind its create; the receiver's RFC 5546 sequence guard additionally drops stale replays. |
| `calendar:invitation-removal` | `organizerEventId` | — | FIFO so a cancel can't be overtaken by the create it cancels. |
| `calendar:rsvp` | `eventId` | — | Two rapid RSVPs from one attendee apply in order. |
| `notification` | `''` (unordered) | `{target}:notif:{tag}` when a tag is present | The receiver's tag upsert is last-write-wins; a pending duplicate adds nothing, so collapse it (chat activity storms, watcher bursts). Tagless notifications don't coalesce. |
| `broadcast` | — | — | Not queued; stays a direct short-circuited call. |

**FIFO means a failed head blocks its own lane** — that is the point of FIFO, and it is bounded:
the lane head backs off, its lane waits, every other (target, fifoKey) lane proceeds. Lane heads
are selected with a not-exists-an-earlier-pending-row-in-my-lane predicate over
`(targetOwnerId, fifoKey, enqueuedAt, id)`, so the due-selection naturally yields at most one row
per lane; an in-memory `inFlight` id set (UploadQueue's field, same name) keeps a mid-delivery row
from being re-selected. Rows with `fifoKey = ''` are unordered by design and **bypass the lane
predicate entirely** — any due row is eligible — so a target's notifications never form a single
serial lane and one failed notification blocks nothing. A **dead** row no longer blocks its lane — for state-replacement verbs the
successor carries full state so skipping is safe; for invitation lanes a skipped create makes the
follow-on update a receiver-side no-op, which is the same outcome as today's silent drop, now
visible in the dead-letter table and manually replayable.

### Delivery, retry, poison

The drain loop (one at a time, concurrent kicks coalesce — `draining`/`retryTimer`/`closing`
fields exactly as in both exemplars):

1. Select due lane-heads (`status='pending'`, `nextAttemptAt <= now`, lane predicate, ordered by
   `enqueuedAt`, batch-limited like `REINDEX_BATCH`).
2. Dispatch the batch concurrently, each delivery wrapped in the **global home-open semaphore**
   (`OUTBOX_DELIVERY_CONCURRENCY = 8`, inheriting `FAN_OUT_CONCURRENCY`'s measured value). A
   delivery = deserialize payload → the existing `sendToHome` switch body (`getHome(target)` +
   `receive*` dispatch).
3. On success: **conditional** delete-on-ack — `DELETE … WHERE id = ? AND updatedAt = ?`, with
   the `updatedAt` read at selection (UploadQueue's post-PUT "still ours → clear the row"
   re-check, ported). This is load-bearing for coalescing: a coalesce upsert that lands while its
   row is mid-delivery — add in flight, revoke upserts the same `{target}:acl:{path.id}` key, add
   acks — bumps `updatedAt`, so the ack misses and the superseded-in-flight row stays pending;
   the never-delivered revoke redelivers. An unconditional delete would silently drop it and
   leave a stale mirror granting read. On transient failure:
   `attempt += 1`, `nextAttemptAt = now + backoff(attempt)` — the same full-jitter curve as
   `uploadBackoffMs`, lifted to a shared util so there is one backoff fact. On **permanent**
   failure — `getHome` throws `ApiError` 404/400 (target user/team deleted, invalid owner) —
   skip retries and dead-letter immediately.
4. After the loop: if rows remain, self-schedule a timer for the earliest `nextAttemptAt`
   (`scheduleRetry`, verbatim from both exemplars). No global poller.

After `OUTBOX_MAX_ATTEMPTS` (proposed: 10 — with the 60s-capped jitter that is roughly ten
minutes of trying) a row flips to `status='dead'`: **kept in the table, never silently deleted**,
logged loudly (`[outbox] dead-lettered <verb> for <target>`). Manual replay = reset
`status/attempt/nextAttemptAt` via the admin surface below. Dead rows older than 90 days are
pruned by a `scheduleInterval` job in `lib/scheduler/jobs.ts` (mirroring `FileHistory.prune`'s
retention).

### At-least-once, audited per verb

Delete-on-ack means a crash between delivery and ack redelivers. Every handler was audited:

- `drive:acl-change` → `receiveSharedPathChange` replaces full state; redelivery converges. One
  imprecision worth naming: the share branch's notification is tagged (the upsert absorbs
  redelivery), but the **unshare branch deletes unconditionally and persists an untagged
  notification** — a redelivered revoke duplicates the "no longer shared" bell row. State still
  converges; at-least-once holds. Tagging that persist is a one-line broken-window fix to take in
  Phase 1.
- `calendar:share` → `receiveShare` is an upsert, `removeShare` a delete-if-exists. Idempotent.
- `calendar:invitation` → `receiveInvitation` returns early on an existing linked event. Idempotent.
- `calendar:invitation-update` → sequence guard drops `sequence <= stored`. Idempotent.
- `calendar:invitation-removal` → no-op on missing linked event. Idempotent.
- `calendar:rsvp` → sets attendee status; replaying the same message is a no-op write. Idempotent.
- `notification` → `NotificationCenter.persist` upserts on UNIQUE tag. Idempotent when tagged;
  **rule: notification verbs routed through the outbox must carry a tag** (every current
  cross-home producer already does — chat mention/activity, watcher file-events, access requests;
  the share/unshare bells are receiver-side `persist` calls inside the `drive:acl-change` handler,
  not `notification` messages).

No handler changes are required; the audit is a property of code that already ships.

### Concurrency budget — and PROPOSAL_FD_BUDGET.md

The outbox semaphore is the **only** limiter on delivery-driven home-opens, replacing
`acl-propagation.ts`'s `fanOutSemaphore` (deleted in Phase 1) and the implicit unbounded/serial
policies of every other seam. It is complementary to the concurrently-written
`PROPOSAL_FD_BUDGET.md` (startup rlimit check + LRU cap on open Homes): the outbox bounds
**in-flight opens** (arrival rate — at most K deliveries can be cold-opening at once), the home
LRU bounds **resident homes** (steady state). The outbox keeps bursts from stampeding the fd
budget; the LRU keeps the budget's total honest. K must stay comfortably below the LRU cap's
headroom; both proposals should cite the shared ~30 fd/Home warm ceiling. Neither replaces the
other.

**Priority lanes: considered and rejected.** One budget means a heavy fan-out can sit ahead of a
cheap notification: a 200-watcher burst enqueued first fills every batch until drained, and a
mention enqueued behind it waits roughly (pending ÷ K) × cold-open cost — for 200 rows through
K=8 at ~50–200 ms per cold open, single-digit seconds. That is acceptable for every queued verb:
nothing in the outbox is read-your-writes (bell notifications, ACL mirrors, and invitations all
tolerate seconds of skew — under retry backoff they tolerate *minutes* by design), so a priority
column would be speculative machinery for a latency class no consumer is sensitive to. Warm-home
deliveries shrink the real number further — the semaphore bounds opens, but a delivery to an
already-resident home clears in milliseconds. Revisit only if `oldestPendingAt` on the admin
surface shows real starvation in production; the change would be one column and one ORDER BY,
not a redesign.

### Shutdown and boot

- **Graceful shutdown** — `gracefulShutdown` in `apps/api/src/index.ts` currently calls
  `drainACLFanOuts()` before `shutdownAllHomes()` because deliveries reopen recipient homes. The
  outbox slots into the same position: `outbox.drain({ flushNow, deadline })` (UploadQueue's
  flush signature) bounded by the existing `SHUTDOWN_DRAIN_BUDGET_MS` discipline; whatever misses
  the deadline stays in the table.
- **Hard crash** — rows are already committed; nothing to do.
- **Boot** — `index.ts` kicks `outbox.drain()` right after `registerScheduledJobs()`. This is the
  server-start answer that the server-level storage decision implies (a per-home table would have
  forced replay-on-home-open instead, with the staleness problem described above). Thereafter:
  kick-on-enqueue plus the self-timer, never a poller.

### Observability

The boring option, chosen deliberately: `[outbox]` log lines on every failure, dead-letter
transition, and boot replay (matching `[sync]` / `[content-reindex]` prefixes), plus
`pendingCount` / `deadCount` getters mirroring `UploadQueue.pendingCount`. Surface: an admin-gated
`GET /settings/outbox` returning `{ pending, dead, oldestPendingAt }` and a
`POST /settings/outbox/replay` that resets dead rows — both in `routes/settings.ts`, the existing
home-independent admin carve-out. No notification-center integration: infra failures belong to the
operator's logs/admin app, not to a user's bell. An admin-app widget can come later if the counts
prove worth watching.

### Sharding trajectory

The outbox is written so that SCALABILITY.md's `lookupShard` sketch lands in one function. Today
the deliver step is `getHome(target)` + the dispatch switch. In a sharded deployment it becomes:
local shard → unchanged; remote shard → POST the serialized row (already JSON with the date-aware
codec) to the target server's relay endpoint, ack on 2xx, and all retry/backoff/FIFO/dead-letter
machinery applies unchanged — the network is just a new transient-failure source the design
already absorbs. Enqueue, ordering, and storage don't change at all. Home migration drains the
mover's lanes first (pause selection for that `targetOwnerId`, flush, cut over). Nothing in this
proposal narrows that future; most of it exists to serve it.

### Module layout and the getHome lint rule

`scripts/check-home-imports.ts` blocks new `getHome` imports in `lib/` — deliberately. The outbox
respects it by construction: `lib/home/outbox.ts` holds the queue mechanics (table access, drain
loop, semaphore, timers) and takes `deliver: (targetOwnerId, message) => Promise<void>` as a
constructor dep — precisely how `ContentReindexQueue` takes its injected `extract`. `home-relay.ts`
keeps `getHome`, keeps the switch (as the deliver function it passes in), and rewrites
`sendToHome` to: `broadcast` → direct short-circuited call; everything else → `outbox.enqueue` +
kick. No new file imports `getHome`; callers of `sendToHome` don't change signatures.

## Frozen-format

Additive only, and unusually clean: a **brand-new** database file (`data/server/outbox.db`) with a
new `OUTBOX_DB_CONFIG` (`lib/home/outbox-db-config.ts`, `currentVersion: 1`, the schema above).
**No existing db-config gets a version bump**; no Yjs root, drive value, or persisted user format
is touched. Existing deployments create the file on first boot via the normal
`openLocalDatabase` migration path. Rollback is equally clean: an older binary simply ignores the
file (accepting loss of any then-pending rows, which is today's status quo for everything but
staged uploads).

## Phasing (each phase shippable)

1. **Outbox + ACL fan-out.** Build `outbox.ts` + db-config + the `sendToHome` split; migrate
   `drive:acl-change` onto it and **delete** `acl-propagation.ts`'s `fanOutSemaphore` /
   `pendingFanOuts` / `drainACLFanOuts` (index.ts and the tests that call it switch to
   `outbox.drain()`). Semantics are already async — durability is a pure win. Target resolution
   and the registry writes stay awaited on the request, exactly as the comment in
   `propagateSharedPathChange` requires.
2. **`FileHistory.notifyWatchers`.** Watcher resolution + ACL re-verification (auth-db reads
   against the pre-captured ancestor chain) stay at enqueue time on the request path — they're
   cheap and the chain snapshot is already the design; only the home-opening `sendToHome` calls
   become rows. Kills the unbounded `Promise.all` on every drive mutation — the fd-burst class.
   Semantic change: delivery is no longer complete when the mutation responds; tests assert after
   `outbox.drain()`.
3. **Chat notification loops.** Mention + activity `sendToHome` calls in `postMessage` become
   enqueues; participant/member resolution and the `coveredEmails` exclusion set (which feeds the
   watcher fan-out) already compute before sending and stay put. Message-send latency stops
   scaling with participant count. No caller reads the loops' results — verified.
4. **Calendar share + invitations.** `propagateCalendarShare` keeps target resolution + registry
   writes awaited, enqueues the rest; the share PUT stops paying N cold opens. Semantic change —
   the awaited→async flip this phase carries: the owner's PUT response is unaffected (it never
   read the fan-out's result), but **target visibility becomes eventually consistent** — a sharee
   sees the calendar only once `receiveShare` writes their `sharedCalendars` mirror at drain
   time, and nothing else can discover an undelivered share (the resync path only re-resolves
   rows already mirrored). Existing calendar share tests that read the target's view right after
   the PUT must drain first. `invite-propagation.ts` enqueues per-target rows with
   `fifoKey = organizerEventId`, fixing the create-vs-update ordering hazard; iMIP `sendMail`
   stays as-is at the seam. RSVP and cancellation ride along (same file, same verbs).
5. **Signup reconciliation — stays.** `reconcileSharesForNewUser` is pull-shaped (reads from
   sharers' homes into the caller's own home) and can't ride a push queue; it is rare and runs
   once per signup. The two `sendToHome` calls in `reconcileSharesForNewTeamMember` may be
   switched to enqueues opportunistically. Recorded as reviewed, not migrated.
6. **Observability surface.** The two admin routes + counts; prune job.

## Open questions

- **Q1 — New `outbox.db` vs a table in `eigen.db`?** One fewer file vs write-volume isolation and
  a purely additive rollout. *Recommendation:* new file — the share registry stays small and
  low-write, the outbox is neither, and a v1 CREATE TABLE in a fresh file is the safest possible
  production migration.
- **Q2 — Should a dead row block its FIFO lane?** Blocking preserves strict order but lets one
  poisoned create freeze an event's lane forever. *Recommendation:* dead rows don't block; for
  state-replacement verbs successors carry full state, and for invitation lanes the skip degrades
  to today's behaviour while remaining visible and replayable — and for state-replacement verbs
  the coalesce upsert's dead-row revival makes manual replay provably safe (a newer change has
  already reclaimed the key). Say it in a comment on the lane predicate.
- **Q3 — Delivery concurrency value?** 8 matches `FAN_OUT_CONCURRENCY`. Honest limit: K bounds
  the *rate* of opens, not the accumulation — delivered homes stay resident for their idle
  window (5 min user homes, 30 min team homes), so a 26-target fan-out through K=8 still ends
  at 26 × ~30 ≈ 780 resident fds. The
  outbox turns the stampede into a queue; *preventing* the `SQLITE_IOERR_VNODE` class under tight
  rlimits is PROPOSAL_FD_BUDGET.md's LRU cap (its phase-2 item). *Recommendation:* start at 8,
  revisit alongside the LRU cap so the two constants are tuned as a pair.
- **Q4 — Where do dead letters surface?** Notification-center to the admin user vs logs + admin
  endpoint. *Recommendation:* logs + `GET /settings/outbox` — infra state belongs on the operator
  surface; a bell notification for a retry-exhausted delivery would itself ride the machinery
  being reported broken.
- **Q5 — Backoff fact placement?** Import `uploadBackoffMs` from `lib/sync` (couples home → sync)
  vs duplicate vs lift. *Recommendation:* lift the full-jitter function to `utils/` and have both
  queues import it — one source of truth per fact, and the sync module's comment already frames it
  as generic.

## Testing

- **Unit (`outbox.test.ts`)**: FIFO within a lane under a failing head; independent lanes
  progress; coalesce upsert replaces payload without re-queuing to lane tail; **coalesce upsert
  against an in-flight row → the conditional ack misses and a second delivery carries the newer
  payload** (the add→revoke race); a dead row revived by a coalescing enqueue redelivers;
  permanent-failure fast-path dead-letters without retries; attempt cap → dead; replay resets;
  boot `drain()` delivers rows written by a previous "process".
- **Integration**: share a path with a cold-home recipient, kill delivery mid-flight (test hook,
  as UploadQueue tests shrink `putTimeoutMs`), restart the outbox, assert the mirror row lands
  exactly once. Calendar: enqueue create+update+cancel for one event with the create forced to
  fail twice — assert final state matches FIFO order. Chat: `postMessage` with N participants
  returns without opening participant homes; `outbox.drain()` then materializes N tagged
  notifications.
- **Determinism for existing suites**: everywhere tests currently await `drainACLFanOuts()`,
  await `outbox.drain()` — same read-your-fanout contract, one queue instead of one-per-seam.
  Phase 4 extends the same treatment to the calendar share tests that today rely on the awaited
  PUT for target visibility.
- **Concurrency**: enqueue a 30-target fan-out and assert (via an instrumented `deliver`) that at
  most `OUTBOX_DELIVERY_CONCURRENCY` deliveries are ever in flight — the regression test for the
  `SQLITE_IOERR_VNODE` class.
