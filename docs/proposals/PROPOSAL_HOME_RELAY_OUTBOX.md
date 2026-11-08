# Proposal: Durable home-relay outbox

A Home is the data folder of one user or team. A push is how one person's action lands in somebody else's Home, such as a share in the recipient's list or a notification in their bell. This proposal gives every push one path: `sendToHome` writes a row to a server-level database, one drain loop delivers the rows, and one function, `deliver`, decides where a message goes.

**Status:** not started; there is no outbox code. The owner said yes to the new `outbox.db` on 2026-11-01. Rewritten and checked against the code on 2026-11-08. It adds no API route. It expands the row "Durable home-relay outbox" in [ROADMAP.md](../ROADMAP.md).

> **TLDR**: `sendToHome` becomes a synchronous row insert in `data/server/outbox.db` plus a kick of the drain. The drain delivers through `deliver`, which is today's `sendToHome` body. All pushes move at once, because they all call `sendToHome` already: ACL changes, calendar shares and invitations, RSVPs and every notification. A row survives a crash and a restart, and a failed delivery retries. It is the third queue of the same shape, after `UploadQueue` and `ContentReindexQueue`. When Homes live in several processes, `deliver` is the one function that learns about them.

## What goes through the outbox

Cross-home traffic comes in several kinds. Only pushes that change a Home become rows, because only they can wait and only they must not get lost.

| Traffic | Row? | Why |
|---|---|---|
| ACL changes, from sharing, rename, restore, trash | Yes | Pushes |
| Calendar shares, invitations, updates, removals, RSVPs | Yes | Pushes, and invitations need order |
| Notifications: chat mentions and activity, file watchers, comment assignment, access requests, admin alerts | Yes | Pushes |
| The pushes of signup and team-join reconciliation (`lib/share/reconciliation.ts`) | Yes | Same `sendToHome`. Its pulls stay pulls |
| `broadcast` SSE events | No, but through `deliver` | They reach open tabs only, and a tab refetches on reconnect. A replayed one means nothing |
| `pull*` and the event writes (`createEventAt` and siblings) | No | The caller needs the answer now |
| `pushUserProfile`, `pushTeamAvatar` | No | Server-wide data, not a Home |
| Chat messages, document edits, Drive requests on a share | No | They are not cross-home calls. The request goes to the owner's Home by `:ownerId` and is stored there. Only their notifications and broadcasts cross |
| Incoming mail (`mailboxDeliver` in `lib/mail/mail.ts`) | No | Postfix is its durable queue and redelivers on a failure. It carries raw bytes, and the sender's server needs the answer. It stays on the `getHome` allowlist |
| Outgoing mail (`sendMail`) | No | Its own transport, and it leaves the server |

So "everything that is pushed" is the rule, not "everything that crosses". A chat message is the example people expect to be in here. Its text never crosses a Home, only the notification about it.

## What is wrong today

| Problem | Where |
|---|---|
| A crash loses every queued and running delivery | All pushes. `acl-propagation.ts` and `sendToUserHomes` hold them in memory |
| A failed delivery is logged and dropped, with no retry | `sendToUserHomes`, `share-propagation.ts`, `reconciliation.ts` |
| Pushes follow three policies: a chain plus the budget of eight, only the budget, or neither | ACL; chat and watchers; calendar, reconciliation, access requests, comment assignment and alerts |
| A share PUT waits for one Home open per target | `Calendar` awaits `propagateCalendarShare` |
| An invitation update delivered before its create is dropped for good, because the receiver has no linked event yet | `receiveInvitationUpdate`, fed by `invite-propagation.ts` |
| A shutdown waits for two of the three policies. Nobody waits for a direct `sendToHome`, and one that opens a Home during the teardown gets a 503 and is lost | `drainDeliveriesWithin` |

A graceful shutdown and the fd burst of chat and watcher fan-outs are solved already, by `sendToUserHomes`. So the outbox's value is durability, retry, ordering, and one path instead of three.

## One function decides where a push goes

`home-relay.ts` splits `sendToHome` in two. `deliver` is the body of today's `sendToHome`: the `broadcast` short-circuit, `getHome` and the switch over `HomeMessage`. No handler moves, and no caller changes its call.

```typescript
export async function sendToHome(target: string, message: HomeMessage): Promise<void> {
    if (message.type === 'broadcast') return deliver(target, message);
    outbox.enqueue(target, message);
}
// The one place that knows where a Home lives. Today it is always this process.
async function deliver(target: string, message: HomeMessage): Promise<void> { /* today's body */ }
```

`lib/home/outbox.ts` holds the table, the drain and the timers, and takes `deliver` as a constructor argument, as `ContentReindexQueue` takes `extract`. So it never imports `getHome`, and `scripts/check-home-imports.ts` needs no change. `sendToUserHomes` stays as the same insert for several targets in one transaction, so a fan-out's rows commit together.

Pulls and event writes cannot use `deliver`, because they return a value. They ask the same question, "is this Home here?", when that question exists. So there is one routing fact with two users: `deliver` for pushes, which retries, and each pull, which fails at once to its caller.

### With several processes, `deliver` is what changes

[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](PROPOSAL_SINGLE_MACHINE_CLUSTER.md) has Caddy route by `ownerId`, so the application never hashes an id. Its routing wrapper becomes the start of `deliver`: a Home loaded here runs the switch, and anything else is a POST to `/internal/relay/:ownerId`, with an ack on 2xx. A network failure is one more transient failure, and the retries and the order already cover it. `enqueue`, the table and the callers don't change. That route belongs to the cluster proposal and gets its yes there.

In a cluster "server-level" means per process. Each process's outbox holds what its own Homes sent, which is the sender-side ownership sharding wants. Moving a Home means draining its rows first.

## The code gets simpler, and the line count goes up

| Leaves | Lines |
|---|---|
| `pendingFanOuts`, `queueACLFanOut`, `drainACLFanOuts` and `drainDeliveriesWithin` in `acl-propagation.ts` | about 47 of 177 |
| `deliveries`, `drainHomeDeliveries`, `countHomeDeliveries` and the permit reasoning in `home-relay.ts` | about 35 |
| The `.catch` handlers and the explanations of them in `chat.ts` and `history.ts`, and a few `try/catch` blocks that guard only a delivery | about 20 |

That is about 100 lines out. In comes `outbox.ts`, its db-config and a small JSON codec for `Date` fields. `content-reindex-queue.ts` is 130 lines and `upload-queue.ts` is 518, and this one sits between them, so a guess is 250 to 300. The net is about 150 to 200 more lines of production code, plus tests.

What gets simpler is what a reader has to know. A caller writes a row and is done. There is one ordering rule, one budget, one retry curve and one shutdown step instead of a separate answer per caller. The reasoning about a delivery waiting for a permit its own fan-out holds goes away, because a team notification now inserts rows for its members and waits for nothing.

The price is that a push is no longer done when `sendToHome` returns. [What changes for callers](#what-changes-for-callers) lists what that touches.

## The third queue of this shape

| | `UploadQueue` | `ContentReindexQueue` | `HomeRelayOutbox` |
|---|---|---|---|
| Durable state | `pending_uploads` in each mount's `metadata.db` | `contentDirty` bit on `paths` | `outbox` in `data/server/outbox.db` |
| Instances | Per mount | Per mount | One per server |
| Kick | `enqueueStaged` | `kick()` | `enqueue()` |
| Concurrency | Per destination | Serial per mount | One budget of eight |
| Order | Newest wins per `storageKey` | Coalesced by the bit | FIFO per lane, newest wins per `coalesceKey` |
| Retry | Forever, with backoff | Forever, with backoff | With backoff, up to a maximum age |
| Crash | Replays on mount open | Replays on mount open | Replays on server boot |

The rows live in one server database because replaying per-home tables on boot would mean opening every Home (about 30 file descriptors each), or waiting until the sender next shows up, which for a share can be days. A separate file keeps the frequent writes out of `eigen.db`'s WAL, and rollout only adds a file.

## The table

```sql
CREATE TABLE outbox (
    id TEXT PRIMARY KEY, targetOwnerId TEXT NOT NULL,
    verb TEXT NOT NULL, payload TEXT NOT NULL,
    fifoKey TEXT NOT NULL, coalesceKey TEXT,
    attempt INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL,
    enqueuedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
```

Indexes: a partial unique index on `coalesceKey`, one on `nextAttemptAt`, and one on `(targetOwnerId, fifoKey, enqueuedAt)`.

A target is a resolved owner id. A team share is one row per member, resolved at enqueue, as the callers resolve it today. `payload` is the message as JSON, with a tagged codec for `Date` fields, exported from `home-relay.ts`. That codec is also the wire format between processes.

An enqueue with a `coalesceKey` upserts: it replaces the payload, resets `attempt` and `nextAttemptAt`, bumps `updatedAt` and keeps `enqueuedAt`.

## Order and coalescing per verb

| Verb | `fifoKey` | `coalesceKey` | Why |
|---|---|---|---|
| `drive:acl-change` | `''` | `{target}:acl:{path.id}` | It carries the full ACL, so only the latest matters. An add and a revoke can't arrive reversed, which is what the chain in `acl-propagation.ts` prevents today |
| `calendar:share` | `''` | `{target}:calshare:{ownerId}:{calendarId}` | It carries the full permission |
| `calendar:invitation`, `-update`, `-removal` | organizer event id | None | True FIFO, so a cancel can't overtake the create it cancels, and an update can't arrive before it |
| `calendar:rsvp` | `eventId` | None | Two quick answers apply in order |
| `notification` | `''` | `{target}:notif:{tag}` | The receiver upserts on the tag, so a pending older one adds nothing |

**A failed head blocks its own lane and nothing else.** The drain selects the earliest row per `(targetOwnerId, fifoKey)`. Rows with `fifoKey = ''` skip that check, so one failed notification never holds back another. An in-memory `inFlight` set keeps a running row from being selected again.

One small function in `home-relay.ts` turns a message into these two keys. The relay's message type requires a `tag` on a notification, so a producer without one fails to compile. All five producers set one today.

## Delivery and retry

The drain runs one at a time, and concurrent kicks coalesce, with the `draining`, `retryTimer` and `closing` fields of both other queues. There is no poller.

1. Select due lane heads, in batches.
2. Run them concurrently under the budget of eight, each as decode and `deliver`.
3. On success, `DELETE ... WHERE id = ? AND updatedAt = ?`, with the `updatedAt` read at selection.
4. On a failure, follow the rules below.
5. If rows remain, set a timer for the earliest `nextAttemptAt`.

**The ack in step 3 has to be conditional.** A revoke can upsert a row while its add is being delivered. The add then acks. An unconditional delete would lose the revoke and leave a stale mirror row in the recipient's list. The changed `updatedAt` makes the delete miss, so the revoke is delivered next.

A failure has two outcomes:

- **The target is gone.** Opening the Home throws an `ApiError` 404 or 400, for a deleted user or team, or an invalid id. The row is logged and deleted, as there is nothing to retry and nothing to replay. Only the error of opening the Home counts. A 404 from inside a receive method retries, because it can be a bug or a passing state.
- **Anything else.** `attempt` goes up, and `nextAttemptAt` moves by the full-jitter curve of `uploadBackoffMs`, capped at 60 s and lifted to `utils/` for both queues to share. A 503 from a restoring Home lands here, and it delivers once the restore is done.

A row whose `updatedAt` is older than `OUTBOX_MAX_AGE_MS` (7 days) is logged and deleted. The age is the limit instead of a number of attempts, because ten attempts at this curve is about ten minutes, and a bucket outage of an hour would then throw away valid deliveries.

**There is no dead state.** That removes the replay route, the prune job and the revival of dead rows on an upsert. The cost is that a row which always fails blocks its own lane for up to 7 days and is then dropped, with a log line. One lane is one calendar event for one person, and a drop is what happens to every failed delivery today. A follow-up behind a dropped create is a no-op on the receiver, also as today.

## Delivery is at least once

A crash between delivery and ack delivers again, so a receiver must tolerate a repeat. Exactly-once is out of scope. The audit of the receivers was last complete in July and the invitation paths changed since, so **rerunning it is the first step of the build**.

Known at this check:

- `drive:acl-change` replaces full state, so it converges. The unshare branch in `lib/drive/shared-with-me.ts` notifies without a tag, so a repeated revoke shows a second bell row. Tagging that notification is part of the build.
- `calendar:share` converges. The notification in `receiveShare` has a tag, and `removeShare` returns early when the row is gone.
- `calendar:invitation` goes through `decideInboundRequest`. `calendar:invitation-update` returns on a missing link and uses the sequence guard. Both need the audit.
- `calendar:rsvp` sets a status, so a repeat changes nothing.
- `notification` upserts on its tag, and the type requires one.

## What changes for callers

**The target's data lands a moment after the request answers.** The receive methods broadcast their own SSE event, so an open tab updates when the row is delivered. This applies to `calendar:share`, which was awaited, and to reconciliation, where a guest's sign-in reconciles and then opens the app. Verify in the browser that the first load after a guest's sign-in and a new signup looks right. Reads never depended on delivery for access, because access is always checked on the owner's side.

**The RSVP broadcast moves.** `propagateRsvp` sends `calendar:rsvp` and then a `broadcast`, and it is the one place that sends both in a row. With a queue, the organizer's tab would refetch before the answer lands. The broadcast moves into the `calendar:rsvp` case of `deliver`, where a receive method finishes its own job ([SCALABILITY.md](../SCALABILITY.md#a-receive-method-finishes-the-job-on-the-target)).

**A caller no longer sees a delivery fail.** `sendToHome` can only fail on the insert. By then the domain write has committed, so a failed insert is logged and the request still answers. That is the window below, not a new one.

**Tests and seed scripts drain first.** The six test files that use the current drains, plus `seed-demo.ts` and `author-fixtures.ts`, move to `outbox.drain()`. Calendar share tests that read the target's view after the PUT need it too.

## The remaining window

The domain write and the insert live in different SQLite files, and no transaction spans them. A crash between the two loses that push. For ACLs this is not microseconds, because the awaited target resolution sits between them. It is accepted, because it is smaller than today's window, and closing it means staging every write. So "accepted" in this proposal means enqueued.

## Shutdown and boot

**A shutdown stops the drain, it doesn't flush it.** `server.ts` replaces `drainDeliveriesWithin` with `outbox.close(SHUTDOWN_DELIVERY_BOUND_MS)`, in the same position. It stops selecting rows and waits for the running deliveries, up to the bound, because a delivery can hang on a Home that never opens, and it must not eat the time the mounts need to upload. Rows wait for the next boot, and a delivery cut off by the bound repeats. `drain()` remains for tests and seed scripts.

**A boot kicks the drain** right after `registerScheduledJobs()`. The budget keeps a long replay from opening many Homes at once.

## Status, not routes

There are `[outbox]` log lines for each retry, drop and boot replay, like `[sync]` and `[content-reindex]`. `getServerStatus` gets `outbox: { pending, oldestPendingAt }`, which `./eigen status` prints over the control socket and `/settings/status` already returns. It costs no new route.

Nothing has to be replayed by hand, because the rows retry until they deliver or age out. If an operator action is ever needed, it belongs on the control socket as an `./eigen` command, as a repair run on the machine, and it gets its own yes.

Nothing goes to the notification center, because a failed delivery is the operator's concern, and the bell would ride the same queue.

## Backups leave the outbox out

`outbox.db` joins `SERVER_RUNTIME_FILES` and not `SERVER_DATABASES`, so a server backup never captures it, and a server restore removes it. A restored server should not replay rows newer than its Homes, and an archive should not hold other people's notification text a second time. A restore therefore loses the pending rows, as a crash does today.

A row holds notification text and invitation titles from many Homes, which breaks "no database mixes users' content" in [SCALABILITY.md](../SCALABILITY.md#a-home-holds-all-of-one-owners-data) for as long as the row exists. That is normally milliseconds, and at most the maximum age. A row for a deleted target goes at its next attempt. SCALABILITY.md and DATABASE.md change with the build.

## The budget bounds pushes, not every Home open

The budget of eight limits how many deliveries open a Home at once. Pulls don't pass it: `lib/drive/aggregate.ts` pulls from all of a user's teams in one `Promise.all`, and every delivered Home stays open for its idle time. So 26 targets at eight at a time still end at 26 open Homes. The cap on open Homes is [PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md). The two numbers should be tuned as a pair.

There are no priority lanes. A 200-watcher burst ahead of a mention delays it by seconds at worst, and nothing queued needs to read its own write.

## Stored format

Only a new file: `data/server/outbox.db` with `OUTBOX_DB_CONFIG` at version 1 in `lib/home/`, opened like `lib/share/db.ts`. No existing db-config changes and no stored format is touched. An older binary ignores the file, which loses the rows pending at that moment.

## Building it

It ships as one change, because every push already calls `sendToHome`. Moving verb by verb would keep two paths alive for no gain, and `drainDeliveriesWithin` can only go once the last one moves.

1. Rerun the receiver audit.
2. Build `outbox.ts`, its db-config and the codec. Split `deliver` out of `sendToHome`. Rewrite `sendToUserHomes`.
3. Delete the bookkeeping listed in [the table of what leaves](#the-code-gets-simpler-and-the-line-count-goes-up), and switch `server.ts`.
4. Move the RSVP broadcast. Require the notification tag. Tag the unshare notification.
5. Add the status field, the runtime-file entry and the docs: SCALABILITY.md, ACL.md, SYNC.md, DATABASE.md.

"Team-removal collab read-revocation" in [ROADMAP.md](../ROADMAP.md) does not use the outbox. It closes open sockets, which only exist in memory, so a row would add nothing. Routing `mailboxDeliver`'s role-address loop is also separate, and comes when a cluster is built.

## Open questions

- **Is 7 days the right maximum age?** Long enough for any outage we would survive, short enough that a row holding someone's text doesn't linger. A wrong value costs little and changes one constant.
- **Is eight still the right budget?** It is the current value. Revisit it with the cap on open Homes.

## Testing

- **Unit (`outbox.test.ts`)**: FIFO under a failing head; independent lanes progress; an upsert replaces the payload and keeps the lane position; an upsert during delivery makes the ack miss and delivers the newer payload; a missing target drops the row without a retry; a 404 from a receive method retries; a row past the maximum age drops; a 30-target fan-out never exceeds eight in flight; a boot delivers rows from a previous process.
- **Integration**: share a path with a cold Home, stop delivery midway, restart the outbox, and the mirror row lands once. Enqueue create, update and cancel for one event with the create failing twice, and the end state follows FIFO order. `postMessage` with N participants answers without opening their Homes, and `outbox.drain()` then shows N notifications. An RSVP reaches the organizer's tab after the status is written.
- **Shutdown**: `outbox.close` returns within the bound on a delivery that hangs, and the row is still there.
- **Browser**: the first load after a guest's sign-in and after a signup with a pending share ([verify-in-browser skill](../../.claude/skills/verify-in-browser/SKILL.md)).
