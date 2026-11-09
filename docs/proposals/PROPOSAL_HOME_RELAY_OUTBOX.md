# Proposal: Durable home-relay outbox

A Home is the data folder of one user or team. A push is how one person's action lands in somebody else's Home, such as a share in the recipient's list or a notification in their bell. This proposal gives every push one path: `sendToHome` writes a row to a server-level database, one drain loop delivers the rows, and one function, `deliver`, decides where a message goes.

**Status:** not started; there is no outbox code. The design was checked on 2026-11-08 by a cold plan review, a falsification seat and a reproduced receiver audit. The owner said yes to the new `outbox.db` on 2026-11-01, and a builder still asks the owner right before building, per AGENTS.md. It adds no API route. It expands the row "Durable home-relay outbox" in [ROADMAP.md](../ROADMAP.md).

> **TLDR**: `sendToHome` becomes a row insert in `data/server/outbox.db` plus a kick of the drain. The drain delivers through `deliver`, which is today's `sendToHome` body. Every push moves in one landing: ACL changes, calendar shares and invitations, RSVPs and notifications. A row survives a crash and a restart, a failed delivery retries, and delivery is at least once, so receivers learn to tolerate a repeat. It is the third queue of the same shape, after `UploadQueue` and `ContentReindexQueue`. When Homes live in several processes, `deliver` is the one function that learns about them.

## What goes through the outbox

Only pushes that change a Home become rows, because only they can wait and only they must not get lost.

| Traffic | Row? | Why |
|---|---|---|
| ACL changes, from sharing, rename, restore, trash | Yes | Pushes |
| Calendar shares, invitations, updates, removals, RSVPs | Yes | Pushes, and invitations need order |
| Notifications: chat mentions and activity, file watchers, comment assignment, access requests, admin alerts | Yes | Pushes |
| The pushes of signup and team-join reconciliation (`lib/share/reconciliation.ts`) | Yes | Same `sendToHome`. Its pulls stay pulls |
| `broadcast` SSE events | No, but through `deliver` | They reach open tabs only, and a tab refetches on reconnect. A replayed one means nothing |
| `pull*` and the event writes (`createEventAt` and siblings) | No | The caller needs the answer now |
| `pushUserProfile`, `pushTeamAvatar` | No | Server-wide data, not a Home |
| Chat messages, document edits, Drive requests on a share | No | The request goes to the owner's Home by `:ownerId` and is stored there. Only their notifications and broadcasts cross |
| Incoming mail (`mailboxDeliver` in `lib/mail/mail.ts`) | No | Postfix is its durable queue, and the sender's server needs the answer. It stays on the `getHome` allowlist |
| Outgoing mail (`sendMail`) | No | Its own transport, and it leaves the server |

So the rule is "everything that is pushed", not "everything that crosses".

## What is wrong today

| Problem | Where |
|---|---|
| A crash loses every queued and running delivery | All pushes. `home-relay.ts` holds them in memory |
| A failed delivery is logged and dropped, with no retry | `sendToUserHomes`, `share-propagation.ts`, `reconciliation.ts` |
| Pushes follow three policies: a per-path chain, one home at a time, or a direct send | ACL; chat and watchers; calendar, reconciliation, access requests, comment assignment and alerts |
| A share PUT waits for one Home open per target | `Calendar` awaits `propagateCalendarShare` |
| A shutdown waits for each running delivery, not for a caller's loop. A later direct `sendToHome` of an invitation to several guests or of a reconciliation gets a 503 and is lost | `invite-propagation.ts`, `reconciliation.ts` |
| An invitation update delivered before its create is dropped for good, because the receiver has no linked event yet | `receiveInvitationUpdate`, fed by `invite-propagation.ts` |

The relay already waits for each running push at a graceful shutdown, and today's code holds no limit on opens, because a fan-out opens one home at a time. So the outbox's value is durability, retry, ordering, and one path instead of three.

## One function decides where a push goes

`home-relay.ts` splits `sendToHome` in two. `deliver` is the body of today's `sendToHome`. No handler moves, and no caller changes its call.

```typescript
const outbox = new HomeRelayOutbox((target, payload) => deliver(target, decode(payload)));

export async function sendToHome(target: string, message: HomeMessage): Promise<void> {
    if (message.type === 'broadcast') { await deliver(target, message); return; }
    await outbox.enqueue(rowOf(target, message)).catch(logFailedEnqueue);
}
// The one place that knows where a Home lives. False means the target is gone.
async function deliver(target: string, message: HomeMessage): Promise<boolean> {
    if (message.type === 'broadcast') { loadedHome(target)?.broadcast(message.event); return true; }
    let home: Home;
    try {
        home = await getHome(target);
    } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return false;
        throw err;
    }
    await receive(home, target, message); // today's switch
    return true;
}
```

**`outbox.ts` handles strings only, so there is no import cycle.** `lib/home/outbox.ts` holds the table, the drain and the timers. Its API is `enqueue(...rows)`, one transaction, where a row is `{target, payload, fifoKey, coalesceKey}`, plus `kick`, `drain`, `close` and `status`, and it takes `deliver(target, payload)` as a constructor argument, as `ContentReindexQueue` takes `extract`. `home-relay.ts` keeps `rowOf`, `encode` and `decode` private. If the outbox needed the keys or the codec, it would import the file that constructs it, and a test that imports `outbox.ts` first would hit a temporal dead zone. `scripts/check-home-imports.ts` needs no change, because it skips `lib/home/` wholesale.

**The codec keeps `Date` fields.** `encode` is `JSON.stringify` with a replacer that tags a `Date`, and `decode` is `JSON.parse` with a reviver that restores it. The replacer must read `this[key]`, because `toJSON` has already turned `value` into a string by then. The same codec is the wire format between processes.

`sendToUserHomes` stays, as one `enqueue` with a row per target, so a fan-out's rows commit together. A notification to a team opens the `TeamHome`, enqueues one row per member from `membersToNotify`, and acks. That `enqueue` runs without the `catch`, so a failed insert retries the team's row.

Pulls and event writes can't use `deliver`, because they return a value. They ask the same routing question, and fail at once to their caller instead of retrying.

### With several processes, `deliver` is what changes

[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](PROPOSAL_SINGLE_MACHINE_CLUSTER.md) has Caddy route by `ownerId`, so the application never hashes an id. Its routing wrapper becomes the start of `deliver`: a Home loaded here runs the switch, and anything else is a POST to `/internal/relay/:ownerId`. A 2xx is an ack, an answer that says the target is gone returns false, and anything else throws and retries. `enqueue`, the table and the callers don't change. That route belongs to the cluster proposal and gets its yes there.

In a cluster "server-level" means per process. Each process's outbox holds what its own Homes sent, which is the sender-side ownership sharding wants. Moving a Home means draining its rows first.

## The code gets more durable, not shorter

| Leaves | Lines |
|---|---|
| `deliveries`, `lastInOrder`, `tracked`, `deliverToEach`, `drainHomeDeliveries` and `drainDeliveriesWithin` in `home-relay.ts` | about 50 |
| The `try/catch` in `notifySharedCalendarUsers`, the only one that guards a delivery alone | about 5 |

In comes `outbox.ts`, its db-config and schema, the codec, the receiver fixes and the status row. The estimate is about 300 to 370 net lines of production code, plus the test migration, which is larger than the production diff. `content-reindex-queue.ts` is 130 lines and `upload-queue.ts` is 518, and `outbox.ts` sits between them.

What gets simpler is what a reader has to know: one ordering rule, one budget, one retry curve and one shutdown step. The price is that a push is not done when `sendToHome` returns ([What changes for callers](#what-changes-for-callers)).

## The rows live in one server database

The outbox has the shape of `UploadQueue` and `ContentReindexQueue`, durable state plus one drain loop, with one instance per server instead of one per mount. Replaying per-home tables on boot would mean opening every Home (25 to 30 file descriptors each), or waiting until the sender next shows up, which for a share can be days. A separate file keeps the frequent writes out of `eigen.db`'s WAL, and rollout only adds a file.

## The table

```sql
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, targetOwnerId TEXT NOT NULL,
    payload TEXT NOT NULL, fifoKey TEXT NOT NULL, coalesceKey TEXT,
    attempt INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX outbox_coalesce ON outbox(coalesceKey) WHERE coalesceKey IS NOT NULL;
CREATE INDEX outbox_due ON outbox(nextAttemptAt);
CREATE INDEX outbox_lane ON outbox(targetOwnerId, fifoKey);
```

A target is a resolved owner id. A team share is one row per member, resolved at enqueue, as the callers resolve it today. The message type is inside `payload`, so there is no `verb` column.

Lanes order by `id`, not by a timestamp, because `sendSeriesExceptions` enqueues in a tight loop and milliseconds tie. Every SQLite index ends in the rowid, so `outbox_due` serves `ORDER BY nextAttemptAt, id` with no sort and `outbox_lane` serves a lane's `MIN(id)`, which `EXPLAIN QUERY PLAN` confirms. `oldestPendingAt` comes from `min(updatedAt)`, an unindexed status read on a small table.

**`enqueue` is async, and its insert is synchronous.** `outbox.db` opens as `lib/share/db.ts` opens `eigen.db`: a `createAsyncSingleton` around `openLocalDatabase`. The file must open lazily, because a CLI command or a test that imports `home-relay.ts` must not create it. So `enqueue` awaits the singleton, then commits in one synchronous `bun:sqlite` transaction, then kicks. `sendToHome` stays async with its signature unchanged, so no caller changes. When its promise resolves, the row is committed. Once the file is open, the await costs microtasks and no I/O, and a caller that doesn't await gets its row just as soon.

An enqueue with a `coalesceKey` upserts: it replaces the payload, resets `attempt` and `nextAttemptAt` and advances `updatedAt`, and the row keeps its `id`.

## Order and coalescing per verb

| Verb | `fifoKey` | `coalesceKey` | Why |
|---|---|---|---|
| `drive:acl-change` | `''` | `{target}:acl:{path.id}` | It carries the full ACL, so only the latest matters. `Drive.runInOrder` keeps two changes to one path in order up to the enqueue, and an add and a revoke can't arrive reversed |
| `calendar:share` | `''` | `{target}:calshare:{ownerId}:{calendarId}` | It carries the full permission |
| `calendar:invitation`, `-update`, `-removal` | organizer event id | None | True FIFO, so a cancel can't overtake the create it cancels, and an update can't arrive before it |
| `calendar:rsvp` | `eventId` | None | Two quick answers apply in order |
| `notification` | `''` | `{target}:notif:{tag}` | The receiver upserts on the tag, so a pending older one adds nothing |

No verb has both keys, so an upsert never touches a lane's order. `rowOf` in `home-relay.ts` turns a message into these keys.

**A notification message must carry a tag.** `tag` is optional in `NotificationPersistInput` today, and the relay's message type requires it with `NotificationPersistInput & { tag: string }`, so a producer without one fails to compile. The six producers already set one: `chat.ts`, `history.ts`, `alert-owner.ts`, `access-request-propagation.ts` and `lib/drive/drive.ts`'s comment assignment. The parameter of chat's `notify` helper tightens with it. A receiver's direct `home.notify` bypasses the relay, so the input type itself stays optional.

The `unshare` notice stays without a tag and relies on fix 1 in [the receiver fixes](#a-repeat-delivery-is-tolerated-and-rare). That is cleaner: the receiver's own state says whether anything changed, as in `removeShare`, while a stable tag would make a repeat turn a read row unread and overwrite an older notice about the same path.

## The drain is a rolling loop

`drain()` is the method `kick` calls, as in `ContentReindexQueue`, and a call during a drain joins it. It uses the `draining`, `retryTimer` and `closing` fields of both other queues, plus `inFlight`, a map of running rows whose size is the budget. There is no poller and no drain-until-empty variant.

1. While `inFlight` holds fewer than eight rows, read the first selectable row by `nextAttemptAt, id`. A row is selectable if its target has no running row, and it has `fifoKey = ''` or is its lane's lowest `id`.
2. If that row is due, start it. If it isn't, set the retry timer for it and stop reading.
3. If nothing runs, the loop ends and `drain()` resolves, with any rows in backoff still in the table. Otherwise wait for a delivery to settle or for a wake, and go to step 1.

**A failed head blocks its own lane and nothing else.** A row behind it isn't selectable, and rows with `fifoKey = ''` never wait for each other.

**One running row per target keeps a stalled Home from eating the budget.** Eight tagged rows for one stalled target would otherwise fill `inFlight`. A rolling loop means a hung delivery holds one slot, where a `Promise.all` batch would stall the whole outbox. A delivery has no timeout, so an outage across eight or more targets still fills the budget, which is accepted.

**`kick` and the retry timer wake the loop.** Without the wake, a new row or an expired backoff would wait for a hung delivery to settle. The timer reads the first selectable row, not the table's minimum `nextAttemptAt`: a row behind a failed head or a busy target is already due, and it would set a zero timer and spin.

## An ack only deletes what it delivered

On success the drain runs `DELETE ... WHERE id = ? AND updatedAt = ?`, with the `updatedAt` read at selection. A revoke can upsert a row while its add is being delivered. An unconditional delete would lose the revoke and leave a stale mirror row in the recipient's list. The miss leaves the row due, and the revoke is delivered next.

An upsert sets `updatedAt = MAX(now, updatedAt + 1)`, so an upsert in the same millisecond still makes the ack miss. A retry doesn't touch `updatedAt`, and it is conditional on it too, or an older delivery's failure would push back a newer payload's `nextAttemptAt`.

## A failure retries, unless the target is gone

**The target is gone.** `deliver` returns false, and the outbox logs and deletes the row. Only the error from `getHome` counts, which is why the `try` in `deliver` covers that one call. It throws 404 or 400 for a deleted user or team, a Home being deleted, or an external or invalid id, and `Drive.init` logs a failed mount and carries on. A 404 from inside a receive method retries, because it can be a bug or a passing state.

**Anything else retries.** `attempt` goes up, and `nextAttemptAt` moves by the full-jitter curve of `uploadBackoffMs`, capped at 60 s. A 503 from a restoring Home is one of these, and it delivers once the restore is done. `deliver` stays on `getHome` and not `openHome`, because [PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md) relies on its `touch()`.

**A failed row older than `OUTBOX_MAX_AGE_MS` (7 days) by `updatedAt` is logged and deleted.** The limit is an age, because ten attempts on this curve is at most 6 minutes, and a bucket outage of an hour would then throw away valid deliveries. It is checked after a failed attempt, so a server that was down for longer still tries each row once. The log has the first failure and the drop, not every retry.

**There is no dead state.** That removes the replay route, the prune job and the revival of dead rows on an upsert. A follow-up behind a dropped create is a no-op on the receiver.

## A repeat delivery is tolerated and rare

A crash between delivery and ack delivers again, so delivery is at least once. **A permanent state returns, it never throws**, so a message that can never apply leaves its lane. No receiver sends mail on a repeat. Three facts drive the table: `isNewerRevision` passes an equal revision, `NotificationCenter.persist` always sets `read: false` and `createdAt: now`, and `dismiss` deletes the row. `coalesce: true` only holds back the toast within 30 s.

| Message | Repeat right after delivery | Repeat after the user acted | Receiver | Answer |
|---|---|---|---|---|
| `drive:acl-change`, add | Nothing | Nothing | `receiveSharedPathChange` | |
| `drive:acl-change`, revoke | Second bell and toast | Same | Its unshare branch | Fix 1 |
| `calendar:share`, grant | Second toast, read row turns unread | Dismissed row returns; a removed calendar returns with a fresh color | `receiveShare`, `ensureSharedEntry` | Fix 2; a returning calendar is what any owner share PUT does today |
| `calendar:share`, revoke | Nothing | Nothing | `removeShare` | |
| `calendar:invitation` | Nothing | Deleted invitation comes back with a bell; own answer resets to pending | `decideInboundRequest`, `fileNewInvitation` | Fix 3; the return is accepted |
| `calendar:invitation-update`, series | Nothing | Own answer resets, "updated" bell; nothing if the copy is deleted | `applyInvitationUpdate` | Fix 3 |
| `calendar:invitation-update`, occurrence | Second toast, unread row, ctag bump, new exception id | Own answer resets; removed occurrence returns | `applyInvitationException` | Fixes 3 and 4; the return is accepted |
| `calendar:invitation-removal`, series | Nothing | Nothing | `removeInvitation` | |
| `calendar:invitation-removal`, occurrence | Second toast, unread row | Dismissed row returns | `cancelInvitationOccurrence` | Fix 5 |
| `calendar:rsvp`, series | Nothing | Nothing | `updateAttendeeStatus` | |
| `calendar:rsvp`, occurrence | Nothing | Ghost occurrence past a truncated series; stuck lane on a deleted event | `rsvpForOccurrence` | Fix 6; the ghost is accepted |
| `notification` | Second toast unless `coalesce` | Read row turns unread; dismissed row returns | `NotificationCenter.persist` | Accepted |

**The first build step makes these fixes, because they also fix today's behaviour:**

1. `receiveSharedPathChange`'s revoke notifies only if the delete removed a row, as `removeShare` does. This also stops the bell to a member who never had a mirror row.
2. `ensureSharedEntry` reports whether it inserted or changed, and `receiveShare` notifies only then. This also stops today's re-raise on every share PUT.
3. A guest's PARTSTAT stays unless the message's SEQUENCE is strictly higher than the stored one, in `applyInvitationUpdate` and `applyInvitationException`. With that a repeat changes nothing, so it sends no notice. It also protects an answer given just after an update was enqueued.
4. `applyInvitationException` patches an existing override at an equal revision and returns false if unchanged, as `applyInvitationUpdate` does with `patchEvent`.
5. `cancelInvitationOccurrence` returns early when the occurrence is already excluded at an equal revision. A guest's own removal stamps `sequence: 0` and no dtstamp, so an organizer's message still gets through.
6. Three stuck lanes end. `rsvpForOccurrence` returns on a missing parent, where it throws 404 and `unlessRefused` rethrows it today. `removeOccurrence` returns on a resource with no master, where `addExclusion` throws today. A disabled team calendar's 404 becomes a drop in the relay's "home without a calendar" check, which also asks the `TeamHome` for its `calendar.enabled` setting. It doesn't override `hasCalendar`, because `calendarOf` uses that, and `get-calendar.ts` and `routes/home.ts` rely on the 404 from `pullCalendars`.

**These stay, each at its cost:**

- A repeat of a `notification` shows a second toast and turns a read row unread, and a dismissed row returns.
- A deleted invitation or a removed occurrence can come back after a repeat, because a Home has no memory of a delete. The clean fix is a tombstone or soft delete, a migration with its own yes.
- A late occurrence RSVP after a truncation can leave a ghost occurrence.
- A row that always fails is a bug. It retries to the maximum age, about 20,000 attempts, with one log line, and each attempt holds its target's Home open.
- A storage outage across eight or more targets slows other pushes.
- A crash between a receiver's write and its notify loses that bell, because the repeat takes the no-notice branch.
- An upsert that keeps resetting `updatedAt`, such as a watcher tag on a busy file to a target that always fails, doesn't age out. It is one row per key.

**A repeat is rare.** A plain crash repeats on boot, while users are locked out, so only a toast or an unread row follows. A late repeat after a user's action needs a receiver that committed and then threw, which retries within 60 s, or a user acting during a long backlog.

## What changes for callers

**The target's data lands a moment after the request answers.** The receive methods broadcast their own SSE event, so an open tab updates when the row is delivered. This applies to `calendar:share`, which is awaited today, and to reconciliation, where a guest's sign-in reconciles and then opens the app. Reads never depended on delivery for access, because access is always checked on the owner's side.

**The RSVP broadcast moves into the receive methods.** `propagateRsvp` sends `calendar:rsvp` and then a `broadcast`, and it is the one place that sends both in a row. With a queue, the organizer's tab would refetch before the answer lands. So `receiveAttendeeStatus` and `receiveRsvpForOccurrence` broadcast `CALENDAR_INVITE_RSVP` after their write, where [a receive method finishes the job](../SCALABILITY.md#a-receive-method-finishes-the-job-on-the-target). It can't go into `updateAttendeeStatus` or `rsvpForOccurrence`, because the guest's own `rsvp` calls those on the guest's Home. It isn't a duplicate. An iMIP REPLY goes through the same two methods and gains the live update it lacks today. An occurrence's answer also announces `CALENDAR_EVENT_UPDATED`, as the relay path does today, and both events end in the debounced `invalidateEventsSoon`.

**A caller doesn't see a delivery fail.** `sendToHome` can only fail on the open or the insert. By then the domain write has committed, so it logs the failure and resolves, and the request still answers. That is [the remaining window](#the-remaining-window), not a new one.

## The remaining window

The domain write and the insert live in different SQLite files, and no transaction spans them. A crash between the two loses that push. For ACLs this is not microseconds, because the awaited target resolution sits between them. It is accepted, because it is smaller than today's window, and closing it means staging every write. So "accepted" in this proposal means enqueued.

## Each commit fsyncs on the main thread in production

`ManagedDatabase` sets `synchronous` only for a config that asks for FULL, and `outbox.db` asks for nothing, so it takes [the build's default for WAL](../DATABASE.md#a-database-that-holds-the-truth-runs-synchronous-full). A probe on Bun 1.4.4 gives FULL on Linux, on both x64 and arm64 (`DEFAULT_WAL_SYNCHRONOUS=2`), and NORMAL on macOS (`=1`). `bun:sqlite` runs on the main thread, so in production every outbox commit is one fsync there, and a Mac hides the cost.

A fan-out to N targets costs one insert transaction plus N ack commits, spread over the deliveries. Each delivery of a notification already commits to the target's `notifications.db` at FULL, so a fan-out goes from N commits to 2N + 1. In the API image under Docker on a Mac, a 50-row insert took 2 to 6 ms, and an ack took 1.3 to 3.2 ms at the median and 14 ms at worst, for 80 to 190 ms over 50 acks. At NORMAL a commit took about 0.01 ms. That disk is not production's, so [the testing section](#testing) measures it there.

This is accepted, because the cost is one small stall per delivery, not one long stall. If the measurement says otherwise, `outbox.db` can set NORMAL, with one more value in the config's type. A process crash then loses nothing, a power loss can lose the newest rows, and a lost ack is one more repeat.

## Shutdown and boot

**A shutdown stops the drain, it doesn't flush it.** `server.ts` replaces `drainDeliveriesWithin` with `outbox.close(SHUTDOWN_DELIVERY_BOUND_MS)` in the same position, after `drainBackupJobs`. `close` stops selecting rows and waits for the running deliveries with `settlesWithin`, up to the bound, because a delivery can hang on a Home that never opens, and it must not eat the time the mounts need to upload. Rows wait for the next boot, and a delivery cut off by the bound repeats.

`close` doesn't close the SQLite handle, because a delivery cut off by the bound can still ack or retry on it until the process exits. An enqueue after `close`, such as from a delivery still running, inserts and skips the kick.

**A boot kicks the drain** right after `registerScheduledJobs()`. The budget keeps a long replay from opening many Homes at once.

## Status, not routes

There are `[outbox]` log lines for a first failure, a drop and a boot replay, like `[sync]` and `[content-reindex]`. `getServerStatus` gets `outbox: { pending, oldestPendingAt }`, which `/settings/status` then returns. `./eigen status` prints it only once `printReport` in `cli/status.ts` gets a row for it. It costs no new route.

Nothing has to be replayed by hand, because the rows retry until they deliver or age out. An operator action, if one is ever needed, belongs on the control socket as an `./eigen` command with its own yes. Nothing goes to the notification center, because a failed delivery is the operator's concern, and the bell would ride the same queue.

## Backups leave the outbox out

`outbox.db` joins `SERVER_RUNTIME_FILES` and not `SERVER_DATABASES`, so a server backup never captures it, and a restored `data/` doesn't hold it. A restored server should not replay rows newer than its Homes, and an archive should not hold other people's notification text a second time. A restore therefore loses the pending rows.

A row holds notification text and invitation titles from many Homes, which breaks "no database mixes users' content" in [SCALABILITY.md](../SCALABILITY.md#a-home-holds-all-of-one-owners-data) for as long as the row exists. That is normally milliseconds, and at most the maximum age. A row for a deleted target goes at its next attempt.

## The budget bounds pushes, not every Home open

Pulls don't pass the budget: `lib/drive/aggregate.ts` pulls from all of a user's teams in one `Promise.all`. Every delivered Home also stays open for its idle time, so 26 targets at eight at a time still end at 26 open Homes. The cap on open Homes is [PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md), and the two numbers should be tuned as a pair.

There are no priority lanes. A 200-watcher burst ahead of a mention delays it by seconds at worst, and nothing queued needs to read its own write.

## Stored format

Only a new file: `data/server/outbox.db` with `OUTBOX_DB_CONFIG` at version 1 and its schema in `lib/home/`. No existing db-config changes and no stored format is touched. An older binary ignores the file, which loses the rows pending at that moment.

## Building it

One unit branch lands together, in six commits. Moving verb by verb would keep two paths alive for no gain, and `drainDeliveriesWithin` can only go once the last verb moves. This order instead makes the behaviour changes visible in their own commits.

1. **Lift the backoff.** `uploadBackoffMs` moves to `utils/timing.ts`. The `upload-limits.ts` header and SYNC.md change with it.
2. **Fix the receivers.** The six fixes in [A repeat delivery is tolerated and rare](#a-repeat-delivery-is-tolerated-and-rare), and the required tag on the relay's message type.
3. **Add the outbox, unused.** `outbox.ts`, the schema, the db-config, the `SERVER_RUNTIME_FILES` entry and its unit tests. `test/server/server-files.test.ts` learns that `outbox.db` is a runtime database.
4. **Switch, atomically.** `deliver`, `enqueue`, the RSVP move, the deletions, `server.ts`, the boot kick, and the test and seed migration. The deletions are `drainDeliveriesWithin`, `drainHomeDeliveries`, `tracked`, `deliverToEach` and `lastInOrder`, with the state behind them.
5. **Report it.** The status field and the `printReport` row, with the `ControlStatus` fixtures in `test/cli/status.test.ts` and `test/server/setup-token.test.ts`.
6. **Document it.** SCALABILITY.md, ACL.md, SYNC.md, DATABASE.md, BACKUP.md (it lists the runtime files), CHAT.md, FILE-HISTORY.md, NOTIFICATION-CENTER.md, CALENDAR.md, an ARCHITECTURE.md row, the ROADMAP row, CHANGELOG, and the help center's `commands-and-files.md`, whose list of what `./eigen status` shows gets the new row.

Closing a removed member's open collab sockets doesn't use the outbox. Those sockets only exist in memory, so a row would add nothing. Routing `mailboxDeliver`'s role-address loop is also separate, and comes when a cluster is built.

## Alternatives we rejected

- **Hint rows that re-derive from live state.** Every delivery opens the source Home too, a removal has nothing to read once the source is deleted, across processes each delivery becomes a remote read, and notifications would stay on a second path. Finding C1 in [API-SIMPLIFICATION-AUDIT.md](../API-SIMPLIFICATION-AUDIT.md) may still merge the invitation messages into one, and the lanes stay as they are.
- **Notifications staying out.** It keeps a second policy and `drainDeliveriesWithin`.
- **Verb-by-verb landing.** It keeps two paths alive until the last verb moves.
- **A delivery timeout.** It is a second mechanism beside the bound on `close`, for an outage that is accepted.
- **Per-home outbox tables.** A boot replay would open every Home, or wait for the sender to return.
- **Exactly-once with a dedupe table in each Home.** It is a migration, and a delivery's effects span several databases.

## Open questions

- **Is 7 days the right maximum age?** Long enough for any outage we would survive, short enough that a row holding someone's text doesn't linger. A wrong value costs little and changes one constant.
- **Is eight the right budget?** Today's code has none: a fan-out opens one home at a time. Revisit it with the cap on open Homes.

## Testing

Test paths are under `apps/api/src/test/`.

- **Unit (`home/outbox.test.ts`)**: FIFO under a failing head, and in a tight loop of enqueues; independent lanes progress; an upsert during delivery makes the ack miss, also in the same millisecond, and delivers the newer payload; a failed older delivery doesn't delay it; a missing target drops the row at once; a 404 from a receive method retries; a failed row past the maximum age drops, and an old row still gets one attempt; a 30-target fan-out never exceeds eight in flight; eight rows for one stalled target leave the budget free; a new row and an expired backoff both start beside a hung delivery; a row behind a failed head doesn't spin the timer; `drain` resolves with rows in backoff; an enqueue after `close` inserts and starts nothing; a `Date` survives the codec.
- **Receivers**: one test per fix, red first, each delivering the same message twice on a real Home.
- **Restart**: tests use their own `HomeRelayOutbox` instances, `markHomeRestoring` for a real 503, and a spawned server, as in `server/server-files.test.ts`, for a real crash. Share a path with a cold Home, stop delivery midway, restart, and the mirror row lands once. Rows from a previous process deliver on boot.
- **Integration**: enqueue create, update and cancel for one event with the create failing twice, and the end state follows FIFO order. `postMessage` with N participants answers without opening their Homes, and `outbox.drain()` then shows N notifications. An RSVP, by relay and by iMIP REPLY, reaches the organizer's tab after the status is written.
- **Shutdown**: `outbox.close` returns within the bound on a delivery that hangs, and the row is still there.
- **Cost**: a chat post to 50 targets on a production-class Linux disk, not a Mac. Report the time in outbox commits and the longest event-loop stall, and decide on `synchronous` from them.
- **Migration**: `authedRequest` drains and `createAuthenticatedClient` doesn't. These move from the current drains to `outbox.drain()`: `setup.ts`, `server/sse.test.ts`, `drive/drive-sse-fanout.test.ts`, `acl/trash-sharing-order.test.ts`, `acl/acl-share-email.test.ts` and `home/home-relay.test.ts`, whose two shutdown tests go. Reads that bypass `authedRequest` need their own drain: `mail/mail-queue-alert.test.ts`, `inviteFromAlice` in `calendar/calendar-quota.test.ts`, the `getHome` reads in `calendar/calendar-invites.test.ts`, and calendar share tests that read the target's view through a client. `calendar/calendar-owner-kinds.test.ts` turns vacuous unless it drains. `scripts/seed-demo.ts` drains, and `scripts/demo/author-fixtures.ts` pushes nothing, so its drain goes. Drop any "upsert keeps lane position" test, because no verb has both keys.
- **Browser**: the first load after a guest's sign-in and after a signup with a pending share ([verify-in-browser skill](../../.claude/skills/verify-in-browser/SKILL.md)).
