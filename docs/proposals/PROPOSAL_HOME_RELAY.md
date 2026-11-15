# Proposal: The home relay is two functions and a queue

A Home is the data folder of one user or team. The relay, `apps/api/src/lib/home/home-relay.ts`, is the one file through which one Home reaches another. Every read across Homes already goes through one of its functions, `getFromHomes`, under one limit on how many Homes open at once. This proposal shrinks its six exported functions to two that cross into another Home's data, `pushToHomes` and `getFromHomes`, plus `broadcastToHomes` for open tabs. A push becomes a row in a queue on disk that retries. Paths are under `apps/api/src/` unless they say otherwise.

**Status:** signed off by the owner on 12 November 2026, who ruled on every open point ([Owner rulings](#9-owner-rulings-12-november-2026)). Built: the calls that need no relay are out of it, and `getFromHomes` with its query tables, its cap and its deadline ([SCALABILITY.md § Reads across many homes go through getFromHomes](../SCALABILITY.md#reads-across-many-homes-go-through-getfromhomes)). Phases 3 to 5 are open ([Phases](#10-phases)). It replaces the earlier durable outbox proposal, which this file took over ([What changed from the outbox proposal](#11-what-changed-from-the-outbox-proposal)). The new `outbox.db` still needs the owner's explicit yes right before it is built, per AGENTS.md. No route and no package are added. [SCALABILITY.md](../SCALABILITY.md) describes the relay as it is today.

> **TLDR:** The relay holds only calls from one Home into another: a route opens the Home its URL names itself, and server jobs live apart. What it holds is a list of query kinds and becomes a list of message kinds too, each declared in its own domain as plain data with one handler. A push is stored in `data/server/outbox.db` and delivered in order per target, at least once. A get asks many Homes at once, at most a fixed number opening together, and leaves out a Home that fails or is too slow. Five places where a signed-in user reads or writes another owner's drive with their own permission stay outside, named in a lint.

## 1. The design in ten lines

1. `pushToHomes<K extends keyof HomeMessages>(targetIds: Iterable<string>, kind: K, message: HomeMessages[K]): Promise<void>` stores one row per target and resolves once they are committed. It never waits for a delivery and never reports one.
2. `getFromHomes<K extends keyof HomeQueries>(ownerIds: readonly string[], kind: K, ask: HomeQueries[K]['ask']): Promise<Map<string, HomeQueries[K]['answer']>>` asks every owner the same question and returns the answers of the Homes that gave one, keyed by owner id.
3. `broadcastToHomes(ownerIds: Iterable<string>, event: SSEvent): void` tells the open tabs of Homes that are loaded. It opens no Home and stores nothing.
4. A message and a query are plain data: ids, strings, numbers, `Date`s, arrays and plain objects of those. Never a `Home`, `Drive`, `Mount`, function, Promise or stream. A target is always an owner id.
5. A kind is declared in its domain as one entry in a type and one in a table: `type DriveMessages = { 'drive:acl-change': { path: DrivePath; acl: DriveACL[] | null; actorEmail?: string; actorName?: string } }` and `export const receiveDrive: Receivers<DriveMessages> = { 'drive:acl-change': (home, m) => home.drive.receiveSharedPathChange(m.path, m.acl, m.actorEmail, m.actorName) }`. Queries do the same with `Answerers<DriveQueries>`, where each kind names its `ask` and its `answer`.
6. The relay joins the tables: `type HomeMessages = DriveMessages & CalendarMessages & NotificationMessages` and `const receivers: Receivers<HomeMessages> = { ...receiveDrive, ...receiveCalendar, ...receiveNotification }`. `Receivers<M>` is the mapped type `{ [K in keyof M]: (home: Home, message: M[K]) => void | Promise<void> }`, so `receivers[kind](home, message)` type-checks with no cast and no `switch` (checked with `tsc --strict` on a scratch file).
7. The tables live in the domain, in `lib/drive/home-calls.ts`, `lib/calendar/home-calls.ts`, `lib/notification-center/home-calls.ts` and `lib/team/home-calls.ts`. **A `home-calls.ts` file has only `import type` lines**: its handlers call methods on the `Home` they are given. The relay spreads each table while it loads, so a table that loaded a module leading back to the relay would make the relay run first and read the table before it exists (a temporal-dead-zone error, reproduced in Bun by the review). `scripts/check-home-imports.ts` holds the rule.
8. **Types hold from the caller to the insert, and stop at the row.** A row read back is `kind: string` and `payload: string`. One function in the relay is the boundary: a type guard `kind in receivers` narrows the kind and drops a row whose kind no longer exists, and the codec's `JSON.parse` gives the payload as `any`, which the handler takes. That is the one untyped hop. No shape check follows, because the row is our own data, and there is no cast.
9. The relay owns the joins, the three functions, the limit on Home opens with its deadline, and the `Date`-keeping codec. `lib/home/outbox.ts` owns the table, the drain, the retry and the shutdown step, and handles strings only.
10. Everything else that touches another owner is one of three named things outside the relay: a route on the owner its URL names, a server job, or a user acting with their own access through `SharedDrive` ([The hard cases](#4-the-hard-cases-each-ruled)).

Seven message kinds remain: `drive:acl-change`, `drive:recent-open`, `calendar:share`, `calendar:request`, `calendar:invitation-removal`, `calendar:rsvp`, `notification`. A notification goes through `Home.receiveNotification`, which a `TeamHome` overrides to push it on to `membersToNotify`, so the relay has no `instanceof TeamHome`.

## 2. Push

**Delivery is at least once, in order per target.** A row is delivered, then deleted. A crash between the two delivers it again on boot. Rows for one target are delivered one at a time in the order they were stored, whatever their kind or sender. Rows for different targets never wait for each other.

**The queue is one server-level database, `data/server/outbox.db`** (ruling 2). It joins `SERVER_RUNTIME_FILES` in `lib/config/paths.ts`, so no backup holds it. It opens like `eigen.db` in `lib/share/db.ts`, lazily through `createAsyncSingleton`, so a CLI command that imports the relay creates no file.

```sql
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, targetId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
    createdAt INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL
);
CREATE INDEX outbox_target ON outbox(targetId, id);
```

**The row is written after the sender's own write, and the two are not atomic.** The sender's write is in its own SQLite file, and no transaction spans two WAL files. A process that dies between the two commits loses that push, as today. For an ACL change the window is not microseconds: `Drive.updateACLDelta` runs the write and `resolveACLUserIds` inside `Drive.runInOrder('acl:<mount>:<path>')` and starts the push there, after the resolution, without awaiting it. The push stays there. Resolving first would write registry entries for a change that may still be refused. The window is accepted: closing it means writing the intent first and re-deriving every message from live state, and a removal has nothing left to read. With the outbox every caller awaits `pushToHomes`, which is only the insert, so a request that answered has its rows on disk (ruling 7). That includes the pushes awaited today: `propagateCalendarShare`, `reconcileShares`, `assignComment` awaiting `propagateAssignment` (`lib/drive/chats.ts`), and `alertOwner` and `alertUser` behind `POST /internal/mail/queue-alert` (`routes/internal.ts`). Each then awaits only the insert, like every push. So the queue-alert route's `notified: true` says the alert is stored, not that the owner has it; what it should mean is an open question for the owner, asked with phase 4.

**One drain loop delivers.** `pushToHomes` kicks it after its insert, a boot kicks it after `registerScheduledJobs()`, and a retry timer wakes it for the next row due. The loop takes the oldest row of each target that has none running, at most `OUTBOX_AT_ONCE` together, opens the target through the relay's open limit, runs the handler and deletes the row. A delivery takes no hold on the Home: a Home that closes under it answers 503 and the row retries.

| What happened | Row |
|---|---|
| `getHome` answers 404 or 400: the owner is deleted, being deleted (`refuseShutHome`), external or invalid | Deleted, one log line |
| An `ApiError` 503, or the open deadline: a restore, a closing Home, a shutdown | Stays and backs off (`uploadBackoffMs`, lifted from `lib/mount/upload-limits.ts` to `utils/timing.ts`), not counted |
| The handler throws `ApiError` 404: what the message is about is gone, or the Home lacks that part | Deleted at once, one log line, never retried, so it cannot hold back the target's other messages (ruling 11) |
| The handler throws anything else: a poison message | `attempt` goes up and it backs off. After `OUTBOX_HANDLER_ATTEMPTS` it is logged and deleted, so it blocks its target only briefly |
| Older than `OUTBOX_MAX_AGE_MS` after a failed try | Logged and deleted |

**A Home without a calendar drops calendar messages before the getter can throw.** Today the relay's `deliver` skips them with `hasCalendar` and `startsWith('calendar:')`. Each calendar receiver starts with `if (!home.hasCalendar) return` instead, and `TeamHome.hasCalendar` answers false while the team's calendar is off (ruling 10). The 404 row above is the backstop. Without both, a calendar message to a guest or to a team with its calendar off would retry and block that target's notifications behind it.

**Cases the review confirmed.** A restore of the sender's Home: rows it stored before still land, harmless because the owner checks every read. A whole-server restore: `stageServerMember` (`lib/backup/restore-server.ts`) deletes the runtime files, so the outbox starts empty. A restore of the target's Home: 503, the rows wait. A deleted owner: 404, dropped. An address re-created under a new user id: old rows target the old id and are dropped, and reconciliation rebuilds from what owners still share.

**A repeat is handled by the handlers, with no dedupe table.** A repeated share, revoke, grant or REQUEST changes nothing and tells nobody (`receiveSharedPathChange` returns when no row changed, `receiveShare` notifies only a new or raised grant, `decideInboundRequest` patches to nothing). A repeated `notification` shows a second toast and turns a read row unread. That is accepted (`NotificationCenter` coalescing holds back the toast for the kinds that set it). One receiver still needs work before the outbox, checked in the code: a repeated occurrence cancel notifies again, because `isNewerRevision` (`lib/ical/ical-component.ts`) passes an equal revision (the outbox proposal's fix 5).

**Share reconciliation stays** (ruling 9). `reconcileShares` (`lib/share/reconciliation.ts`) is not a delivery repair: a guest can be removed and come back, and an account can be shared with before it exists. Its pushes go through `pushToHomes`. They run outside `runInOrder`, so a stale add can land after a revoke: a ghost row that lists nothing and a toast, no access, as today.

**Live tab updates are not pushes** (ruling 3). A broadcast reaches only loaded Homes, opens none and means nothing after a restart. `broadcastToOwnerAndMembers` moves to `lib/drive/sse-events.ts`, since who may read a path is Drive's knowledge, and awaits its own member list.

**Shutdown.** `server.ts` calls `outbox.close(SHUTDOWN_DELIVERY_BOUND_MS)` where it calls `drainDeliveriesWithin` today: stop taking rows, wait for the running ones up to the bound. `close` leaves the database handle open until the process exits, so a push after it still stores its row and only skips the kick. `getServerStatus` gains `outbox: { pending, oldestPendingAt }`.

## 3. Throttling and limits

The open cap and its deadline are built: `HOME_OPENS_AT_ONCE` and `HOME_OPEN_DEADLINE_MS` in `home-relay.ts`. With the outbox, a delivery opens its target through the same cap.

| Limit | Constant | At the limit | Measure before choosing the number |
|---|---|---|---|
| Rows delivering at once | `OUTBOX_AT_ONCE`, below the open cap, so a long fan-out never queues ahead of a page load | Rows wait in the table | Time for a 50- and a 500-target fan-out to land, and a list load meanwhile |
| Deliveries per target | One | Later rows wait | None: it is the ordering rule |
| Handler failures, row age | `OUTBOX_HANDLER_ATTEMPTS`, `OUTBOX_MAX_AGE_MS` | Logged and dropped | The longest outage we expect to survive |
| Commit cost | `synchronous` of `outbox.db` | n/a | Time in outbox commits and the longest stall for a chat post to 50 targets on a production Linux disk. If it shows, the outbox runs NORMAL: safe against a crash, not a power cut |

Not limited here: Homes open in total (the fd budget), calls in flight to one Home, and callers (no 429).

## 4. The hard cases, each ruled

1. **A copy between two owners** (`Drive.copyPath` handing a live `Mount` to `receiveCopy`). Stays outside (ruling 6). A tree copy is a stream with one writer and a cleanup, neither a message nor a query. The ROADMAP row stays, as the known blocker for sharding.
2. **Import from Drive, mail attach, save to Drive, the mail grant** (`readImportSourceBytes`, `attachFromDrive`, `saveAttachmentsToDrive` with its quota read in `lib/config/enforcement.ts`, `grantAccessForReferences`). Stay outside as one named class (ruling 6): a signed-in user acting on another owner's drive with their own permission is `SharedDrive`'s job. The relay is one Home acting on another with no user check.
3. **`mailboxDeliver`**. Stays outside. The server hands a mail to a Home, and Postfix is its queue and waits for the answer.
4. **A Promise in a call.** `broadcastToOwnerAndMembers` takes its `members` as a Promise. Its caller awaits it instead, so a broadcast carries plain data.

Also outside and documented as process-level lifecycle: `evictHome` in a delete and a restore, the restore's warm-up `getHome`, `broadcastToLoadedHomes`, `atHome` in the guest cleanup.

## 5. Delivery and ordering code today, and its fate

| Mechanism | Guarantees today | Fate |
|---|---|---|
| `deliveries`, `tracked`, `drainHomeDeliveries`, `drainDeliveriesWithin` (`home-relay.ts`, 10 s in `server.ts`) | A graceful shutdown waits for running pushes | Removed with the outbox. `outbox.close` takes their place, and rows wait on disk |
| `lastInOrder` (`home-relay.ts`) | ACL fan-outs for one path never swap | Removed with the outbox: order per target covers it. Kept until then |
| `deliverToEach` (`home-relay.ts`) | A fan-out opens one Home at a time | Replaced by the open cap and one row per target |
| `Drive.runInOrder` (the `acl:` chain in `updateACLDelta` and `removePath`) | An ACL write, its resolution and its push, and a trash, run one after another per path | Kept. The push stays inside it |
| `Home.hold`, `withHomeHeld`, `closeWhenIdle`, `refuseIfClosing` (`home.ts`) | A Home stays open while used and refuses late work with a 503 | Kept, untouched. A delivery does not hold: a 503 retries |
| The restoring, deleting and shutdown marks, `refuseShutHome` (`get-home.ts`) | No Home opens over a folder being replaced or removed | Kept. The failure table reads their 503 and 404 |
| `Mount.runInBackground`, `backgroundDone` | A mount's background jobs end before it closes | Kept. They push nothing |
| `calendar.writeLock`, `isNewerRevision`, `keepOwnAnswer`, `unlessRefused` | One decision per inbound message, and an older message loses | Kept. They are what makes a repeat safe. The equal-revision cancel is fixed in phase 4 |
| `propagateCalendarShare` (awaited by its callers), `propagateInvitation`, `propagateCancellation`, `propagateRsvp` (detached by their callers) | One target after another, each failure logged and skipped | Each loop becomes one `pushToHomes`. The `try/catch` around a delivery goes |
| `receiveSharedPathChange`'s no-op returns, `NotificationCenter` coalescing | A repeat adds no row and mostly no notice | Kept. A second toast for a repeated notification is accepted |
| `reconcileShares` | A new or returning account gets what is shared with it | Kept (ruling 9), over `getFromHomes` and `pushToHomes` |
| The test and script drains (9 test files, `test/setup.ts` among them, `scripts/seed-demo.ts`, `scripts/demo/author-fixtures.ts`) | A test reads the other side after delivery | Move to `outbox.drain()` |

## 6. Sharding later

**What the contract guarantees today:** payloads and answers are plain data the codec round-trips. The owner id is the only address. No object is shared between the two sides. A handler does the whole job from the payload, and a time that matters travels in it, as an invitation's `dtstamp` does. A push returns no result. A get may return fewer answers than it asked for.

**What changes then, inside the relay only:** the two places that call `getHome` ask whether the Home is here and otherwise send the same kind and payload to its process. The cluster proposal needs two internal routes, one for a push and one for a get, and the queue a way for several processes to share one file. Both get their own yes then.

**Not solved here:** the Home cache and marks in `get-home.ts`, the auth database and share registry, schedulers, the backup job map, data epochs, the settings cache, rate limiters, name reservations, WebDAV locks, the instance lock, and the exceptions of section 4. **Not built now:** no transport, no router, no "is it local" check, no process column, no mode option.

## 7. What gets deleted and what it costs

Six exported functions become three: `sendToHome` and `sendToUserHomes` become `pushToHomes`, `broadcastToOwnerAndMembers` moves to `lib/drive/sse-events.ts` over a new `broadcastToHomes`, `getFromHomes` stays, and the drains leave as sections 2 and 5 say. `home-relay.ts` goes from 273 lines to about 150. In come `outbox.ts` with its schema and config (about 200) and the message tables, mostly moved bodies, beside the query tables in `lib/drive/home-calls.ts` and `lib/calendar/home-calls.ts` and in a new `lib/notification-center/home-calls.ts`. The gain is one rule per direction.

**The lint** is `scripts/check-home-imports.ts` at the repo root, a text check. In `lib/` it holds the `home-calls.ts` rule already and gains one more: `getSharedDrive` may be named only in a listed file: the resolver `lib/drive/get-drive.ts`, the `lib/drive/index.ts` barrel, `shared-drive.ts` and `drive.ts` where comments name it, the five routed WebDAV files (`lib/webdav/propfind.ts`, `proppatch.ts`, `locks.ts`, `resource.ts`, `move-copy.ts`), and the three exceptions `import-source.ts`, `mail.ts` and `access-grants.ts`. In `routes/` (ruling 6) it checks one thing: the first argument of every `getHome(` and `getSharedDrive(` is the text `params.ownerId` or `user.id`, or the file-and-argument pair is on a list with its reason. Three pairs fail it today: the copy target in `routes/drive.ts`, the destructured `ownerId` in `routes/collab.ts` and the restore warm-up in `routes/backup.ts`. `lib/caldav/caldav-router.ts` is a routed file in `lib/` that opens only the signed-in user's own Home after `requireSelf`: it stays on the `getHome` allowlist, and this rule scans it as it scans `routes/`. It does not follow a value through a helper, so a wrapper that takes an `ownerId` is listed once and its callers are not checked.

**Tests.** The get's contract tests exist in `test/home/home-relay.test.ts`. Contract tests at the other two functions and the codec: each kind round-trips it. Outbox unit tests on their own instance: order per target, each row of the failure table, close within the bound, a push after close. Crash tests with a spawned server as `test/server/server-files.test.ts` does. One test per receiver, delivering twice. 22 files under `test/` import the relay, and those that push or drain change names. 9 of them drain.

## 8. Alternatives

**(a) No outbox, more reconciliation at read time.** Least code, and a lost revoke already hides itself. It loses because five losses are never repaired today (an add to an existing user, a user-to-user calendar grant, an invitation removal, an RSVP, every notification), repairing them by reading needs the registry to hold every share, and it does nothing for a target that is briefly shut.

**(b) One outbox per sending Home.** The closest. It keeps "no database mixes two owners' content" true and gives order for free. It loses because delivery would depend on the sender's Home being open, a boot cannot find pending rows without scanning every folder, server-origin pushes such as an admin alert have no sending Home, and it costs three file descriptors per open Home.

**(c) Keep the typed functions, add the bound and the lint.** The smallest diff. It loses because the count is the problem. Its bound is built, as the cap on opens.

**(d) A log each Home exposes, pulled by the others.** No push at all. It loses because a puller must know which logs to read and must poll or be told, and each Home needs a log with a cursor per reader.

**Against this design:** about 200 lines of queue for a crash that rarely comes, where what survives is the retry for a shut target and one delivery policy for three. A row is a second copy of the truth while it lives. The two mapped types must be learned once, and the stored row is untyped for one hop. The cap is a global choke point: in a bucket outage lists come back partial until hung opens settle. Queued pushes change what a user sees for a moment. And five user transfers, one copy route and inbound mail are fenced, not folded in.

## 9. Owner rulings (12 November 2026)

1. Build the outbox, as the last build phase. The new database needs the owner's explicit yes right before.
2. One outbox for the whole server, left out of backups.
3. Three exports: `pushToHomes`, `getFromHomes`, `broadcastToHomes`. `getFromHomes` is built.
4. One cap on concurrent Home opens, for lists and deliveries, with a deadline per Home. A slow Home is left out of that load. This replaces the 9 November 2026 "no limit" ruling. The number follows a measurement. This one is built.
5. Calendar routes open the routed owner's Home directly, as Drive routes do. This one is built.
6. Copy to another owner's drive, import from it, mail attach from it, save a mail attachment to it and share-on-send stay outside on a named list the lint guards, in `lib/` and in `routes/`.
7. Every push answers before delivery. No awaited path remains. Check a guest's first page and a team calendar share in the browser when built.
8. Team quota overrides stay in the team's Home. Measure what an upload costs for a member of many teams before deciding more. The measurement is done: for a member of 50 teams, a warm metered write cost 1.1 ms instead of 0.11 ms and a 500-write sync 563 ms instead of 60 ms; the difference was one auth-database query per team asking whether the team exists. So `getFromHomes` asks the auth database nothing and takes a 404 on opening a Home as a gone owner ([SCALABILITY.md § Reads across many homes go through getFromHomes](../SCALABILITY.md#reads-across-many-homes-go-through-getfromhomes)).
9. Share reconciliation stays. Only code whose sole job is to cover a lost or late delivery goes.
10. A team whose calendar is switched off has no calendar: messages to it are dropped and members' entries for it are removed. Switching it on later shows what was stored before; nothing sent while it was off arrives. This one is built.
11. A queued message whose subject is gone (the handler answers 404) is dropped at once with one log line, never retried, so it cannot hold back the target's other messages.
12. It is built on its own branch, after the Drive simplification has landed.

## 10. Phases

It is built on its own branch, after the Drive simplification has landed (ruling 12).

| # | Step | Size | Risk | Owner's yes |
|---|---|---|---|---|
| 3 | `pushToHomes` and `broadcastToHomes` with the message tables, **delivered directly as today**: calls stay awaited or detached as they are, and `lastInOrder`, `deliveries` and the drains stay. `Home.receiveNotification`. Then the lint | M | Low | None |
| 4 | The outbox. First the receiver of the equal-revision cancel. Then `outbox.ts` unused with its tests, then the switch in one commit (every caller awaits the insert, `lastInOrder` and the drains go), then the status row | M | Medium | A new database, `data/server/outbox.db`, asked right before, and what `notified` on the queue alert means ([Push](#2-push)) |
| 5 | Docs: the files listed below | S | None | None |

The docs that describe today's relay and change with it: `docs/SCALABILITY.md` (the TLDR, § Every cross-home call goes through the relay, § Reads across many homes go through getFromHomes, § A receive method finishes the job on the target, § lib/ may not import getHome, § A relay message in flight is lost on a crash). `docs/ARCHITECTURE.md`: the Home relay row and the pitfall "One Home never calls `getHome()` for another's data". `docs/ROADMAP.md`: "Durable home-relay outbox", "Empty the `getHome` allowlist in `lib/`", "A copy to another owner's drive opens both Homes outside the relay", "A move to another owner's calendar is two steps the client runs", "A team calendar's event changes reach only its named shares". `docs/ROADMAP-POST-1.md`: "Single-machine multi-process cluster", "A redelivered or reordered REPLY". The proposals `PROPOSAL_SINGLE_MACHINE_CLUSTER.md` (§ Modified `home-relay.ts`), `PROPOSAL_FD_BUDGET.md` (its `sendToUserHomes` passages) and `PROPOSAL_HOME_LIFECYCLE.md` (one sentence names `sendToUserHomes` and `broadcastToOwnerAndMembers`). The domain docs that name the old functions: `docs/SSE.md`, `docs/NOTIFICATION-CENTER.md`, `docs/CALENDAR.md` (§ Sharing is pushed), `docs/STORAGE.md`, `docs/ACL.md`, `docs/BACKUP.md`, `docs/DATABASE.md`, `docs/SYNC.md`, `docs/CHAT.md`, `docs/FILE-HISTORY.md`. The proposals that name `sendToHome` or the relay: `PROPOSAL_CALENDAR_IMPORT.md`, `PROPOSAL_DATA_INTEGRITY.md`, `PROPOSAL_SCRIPTING_PLATFORM.md`, `PROPOSAL_TEAM_ADDRESSES.md`. With phase 4: `CHANGELOG.md` and the help center's `commands-and-files.md`.

## 11. What changed from the outbox proposal

This file first held the durable home-relay outbox proposal, last checked on 8 November 2026, which only covered pushes; its history is in git.

**Kept from it:** a server-level `outbox.db` in `SERVER_RUNTIME_FILES`. `outbox.ts` handling strings only, with the delivery passed in. The `Date`-keeping codec. A rolling drain with one running row per target. Dropping a row whose target is gone, and a maximum age. At least once with tolerant receivers and no dedupe table. `close` with a bound and a kick at boot. Counts in `getServerStatus`. Lifting `uploadBackoffMs`. The honest window between the two commits.

**Dropped from it, and why:** `fifoKey`, `coalesceKey`, the upsert and the ack conditional on `updatedAt`, because order per target does the job with one index. The required `tag` on a relayed notification, which existed for coalescing. "No handler moves and no caller changes". Broadcasts through `deliver`. "Pulls are out of scope". Retrying a throwing handler for seven days, which would block a person's bell. Not overriding `hasCalendar`, since the 404 that `syncTeamCalendars` read becomes a null answer. One landing with no step before.
