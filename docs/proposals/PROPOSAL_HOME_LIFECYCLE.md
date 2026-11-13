# Proposal: homes, collab documents and container databases are held by their users

**Status:** built, except step 5, which the owner dropped on 2026-11-02. Steps 1 to 4 and 6 are in the code (step 1 came with the backup-safety program), and [DATABASE.md](../DATABASE.md#a-reader-holds-a-container-database-only-while-it-runs), [COLLAB.md](../COLLAB.md) and [BACKUP.md](../BACKUP.md) describe them as they are. Step 5 was dropped because a closing review found it fixes no failure and would reopen a home that a failed deletion must keep shut: one map cannot hold "deleting" and a recovery's "keep shut" at once, which today's two sets can. The page keeps the reasons, the rejected primitive and one open question. Written 2026-11-02 from two read-only audits, a design note for one generic lease primitive and an adversarial review of that note. The text below says what was true before the program unless it names a step as built.

This proposal made the open and close of a Home, a collab document and a container database follow from who uses them, instead of from timers and guesses. Before the program a Home stayed open because every getter called `touch()`, the collab keepalive called `touchHomeIfLoaded`, the SSE stream called `getHome` every 15 s, a backup called `hold()`, and `requestedSince` with `BACKUP_RELEASE_MS` guessed how long a backup still needed it. Each of those was a fix for a bug, and together they made the lifecycle hard to reason about. Six small steps replaced most of them with the `hold()` that already existed, two refusals and one callback per hold, and no new abstraction.

## Problem (before the program)

Who opens a Home, who holds it and who closes it is spread over many places, and a close can run under a user who still needs it. Five concrete failures follow from that.

An open SSE stream reopens its Home after shutdown closed it. `createSSEStream`'s keepalive calls `getHome` every 15 s, so a tick during `shutdownAllHomes` builds a new Home that `process.exit` then kills mid-init. Crash recovery covers the data, so no bytes are lost, but a half-initialized Home is killed without a close.

A request that holds a Drive across a Home close fails with `RangeError: Cannot use a closed database`, a 500. A WebDAV PUT over a slow link that outlasts the idle timeout does it, and so does any request in flight when `evictHome` runs for a restore or a deletion.

A re-pointed mount could outlive its Home. `Drive.updateMount` ran `removeMount` then `addMount`; a `Home.close` between the two left a Mount whose queues and timers nobody closed.

Readers leave container databases open until the mount closes. `readStickiesContent`, `readChatContent`, `captureCollabSource`, a chat request and the comment index open through the mount's document-db slot and never close, so a reindex keeps every board and chat it read open, each with its fds and its sync interval.

A chat request racing a chat version restore gets a 500, because `replaceContainerDataDb` closes the database the request still holds.

## What was considered and rejected

A generic `LeaseCache<K, V>` (acquire, release, linger, a closing gate) for homes, collab documents and container databases, with a request hook on the `:ownerId` segment. An adversarial review rejected it for now, for four reasons. It is about 100 shared lines plus three rewritten close paths (the Home's S3 drain, the workbook compaction at the end of a collab linger, the container snapshot at close), so the ideas a maintainer must hold grow from about five to about sixteen, one of them an invisible "you must hold the home" rule on every `getHome`. Putting container databases on it deadlocks by deadline: a chat request would hold its `data.db` and then take the container path lock in `ChatRoom.open`, while `replaceContainerDataDb` takes the path lock and then the database. A "no lease held after each test" check fails on every share, chat and history test, because those fire `sendToUserHomes` and `broadcastToOwnerAndMembers` without awaiting them. And `atHome` is read by calendar and contacts for `meteredIngest` during init, which a lease lookup would answer wrongly on a cold Home. Revisit the primitive only after the snapshot-at-close question below is settled.

## The six steps

Each step merged alone with the suite green, started with a test that failed on the old code, and deleted what it names.

1. **A shutdown gate (XS). Built.** A `shuttingDown` flag in `get-home.ts`, set by `shutdownAllHomes`; `openHome` refuses with a 503 once it is set. Fixes the SSE stream that reopens a Home during shutdown. The backup-safety program built it on 2026-11-02, next to its restart-notice work in the same file.
2. **A closing Home refuses new parts (XS). Built.** `Home.getLocalDatabase` refuses with a 503 once `close()` has begun. `Drive.addMount` refuses on a closing Home, and closes a mount that finished starting after the close began, and `Drive.destruct` waits for a mount still starting, which closed the re-pointed-mount race. A mount is no longer re-pointed: new storage or an on/off switch for a team drive closes the whole home (`TeamHome.updateMount`), and the next home opens the mount on the saved settings.
3. **Connections hold their Home (S). Built.** `createSSEStream` takes `Home.hold(onClosing?)` in `start` and lets go when the stream ends; a collab socket takes it through `Drive.holdHome` once `getSharedDrive` finds its document and lets go in `cleanupSession`. `hold` takes an optional callback per hold, which the Home runs when the close starts (`holderCloseCallbacks`), before its parts close. A collab socket passes a callback that closes it with 1013, and a document that closes alone closes its sockets plainly, so a client reconnects to the next Home. This replaced `connections.ts`, the SSE stream's 15 s `getHome` loop with its re-subscribe, `touchHomeIfLoaded` and the collab keepalive's `onTick`.
4. **Long requests hold their Home (XS). Built.** The WebDAV PUT and the convert and copy routes take `hold()` for their duration. Fixes the idle half of the closed-database 500. An evict for a restore or deletion still closes under them, by design.
5. **One shut state per Home (XS). Dropped on 2026-11-02.** The idea was to merge the restoring set and the deleting set into one `Map<ownerId, ApiError>` with `shutHome` and `reopenHome`. A closing review found it fixes no failure, and it would reopen a home that a failed deletion must keep shut: one map cannot hold "deleting" and a recovery's "keep shut" at once, which the two sets can. They stay two sets.
6. **Container databases count their holders (S). Built.** A holder count on the document-db slot, `mount.withDatabase(config, pathId, fn)` for the readers above and `holdDatabase` for an open collab document, a five-minute idle close (`IDLE_CLOSE_MS`) after the last holder lets go, and a close that waits up to `HOLDER_WAIT_MS` for the holders. Fixes the readers that keep databases open and the chat request racing a version restore. Keep the order `document-db.ts` documents, container path lock, then slot, then tree lock, on every path. A reader must not hold a database while it waits for the path lock: `ChatRoom.open` takes that lock, and `replaceContainerDataDb` takes it before the database, so a held reader and a restore would wait on each other.

## What it leaves unsolved

The idle timer stays a guess for a short request that is neither a connection nor a long request; such a request is quick, so the guess is safe in practice. Three mechanisms stay three (Home holds, collab lingers, container-db holders), each simpler than today. A restore or deletion still evicts under a short request in flight, which then gets a clean 503. The FD budget proposal gets its "in use" answer for free: after steps 3 and 4, `holds > 0` means a connection or a long request.

## Decisions for the owner

Open. None of the steps added a route, a migration, a package or a stored format. One product question decides whether the generic primitive is ever worth it: should a collab or container close still take a version snapshot (`skipFinalSnapshot` is threaded through five layers to turn it off), or should versions come only from edits and explicit saves? Answer it before revisiting the primitive.
