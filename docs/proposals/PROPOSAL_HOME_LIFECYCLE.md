# Proposal: homes, collab documents and container databases are held by their users

This proposal makes the open and close of a Home, a collab document and a container database follow from who uses them, instead of from timers and guesses. Today a Home stays open because every getter calls `touch()`, the collab keepalive calls `touchHomeIfLoaded`, the SSE stream calls `getHome` every 15 s, a backup calls `hold()`, and `requestedSince` with `BACKUP_RELEASE_MS` guesses how long a backup still needs it. Each of those was a fix for a bug, and together they make the lifecycle hard to reason about. Six small steps replace most of them with the `hold()` that already exists, two refusals and one listener set, and no new abstraction.

**Status:** nothing of it is built, except the part of step 2 that landed on 2026-11-02. Written 2026-11-02 from two read-only audits of the lifecycle and the backup path, a design note for one generic lease primitive, and an adversarial review of that note, all checked against develop at 0ae4388a5. The owner chose this small version on 2026-11-02. File and symbol names are pointers to verify against the code at build time, not facts: the backup and SSE code was changing that day.

## Problem

Who opens a Home, who holds it and who closes it is spread over many places, and a close can run under a user who still needs it. Five concrete failures follow from that.

An open SSE stream reopens its Home after shutdown closed it. `createSSEStream`'s keepalive calls `getHome` every 15 s, so a tick during `shutdownAllHomes` builds a new Home that `process.exit` then kills mid-init. Crash recovery covers the data, so no bytes are lost, but a half-initialized Home is killed without a close.

A request that holds a Drive across a Home close fails with `RangeError: Cannot use a closed database`, a 500. A WebDAV PUT over a slow link that outlasts the idle timeout does it, and so does any request in flight when `evictHome` runs for a restore or a deletion.

A re-pointed mount can outlive its Home. `Drive.updateMount` runs `removeMount` then `addMount`; a `Home.close` between the two leaves a Mount whose queues and timers nobody closes.

Readers leave container databases open until the mount closes. `readStickiesContent`, `readChatContent`, `captureCollabSource`, `ChatRoom.init` and the comment index open through the mount's document-db slot and never close, so a reindex keeps every board and chat it read open, each with its fds and its sync interval.

A chat request racing a chat version restore gets a 500, because `replaceContainerDataDb` closes the database the request still holds.

## What was considered and rejected

A generic `LeaseCache<K, V>` (acquire, release, linger, a closing gate) for homes, collab documents and container databases, with a request hook on the `:ownerId` segment. An adversarial review rejected it for now, for four reasons. It is about 100 shared lines plus three rewritten close paths (the Home's S3 drain, the workbook compaction at the end of a collab linger, the container snapshot at close), so the ideas a maintainer must hold grow from about five to about sixteen, one of them an invisible "you must hold the home" rule on every `getHome`. Putting container databases on it deadlocks by deadline: a chat request would hold its `data.db` and then take the container path lock in `ChatRoom.init`, while `replaceContainerDataDb` takes the path lock and then the database. A "no lease held after each test" check fails on every share, chat and history test, because those fire `sendToUserHomes` and `broadcastToOwnerAndMembers` without awaiting them. And `atHome` is read by calendar and contacts for `meteredIngest` during init, which a lease lookup would answer wrongly on a cold Home. Revisit the primitive only after the snapshot-at-close question below is settled.

## The six steps

Each step merges alone with the suite green, starts with a test that fails on today's code, and deletes what it names.

1. **A shutdown gate (XS).** A `shuttingDown` flag in `get-home.ts`, set by `shutdownAllHomes`; `openHome` refuses with a 503 once it is set. Fixes the SSE stream that reopens a Home during shutdown. The backup-safety program took this step on 2026-11-02, next to its restart-notice work in the same file: check develop before building it.
2. **A closing Home refuses new parts (XS).** `Home.getLocalDatabase` refuses with a 503 once `close()` has begun: landed on branch `lifecycle-fixes` on 2026-11-02. Left: `Drive.addMount` refuses on a closing Home, which closes the re-pointed-mount race.
3. **Connections hold their Home (S).** `createSSEStream` takes `hold()` in `start` and lets go in `cancel`; the collab socket takes it in `open` and lets go in `cleanupSession`. A `Home.onClose(listener)` set, fired from `close()`, ends both with their existing retry codes, so a client reconnects to the next Home. Deletes `connections.ts`, the SSE stream's 15 s `getHome` loop with its re-subscribe, `touchHomeIfLoaded` and the collab keepalive's `onTick`. Touches the SSE stream, so it waits for backup-safety to land.
4. **Long requests hold their Home (XS).** The WebDAV PUT and the convert and copy routes take `hold()` for their duration. Fixes the idle half of the closed-database 500. An evict for a restore or deletion still closes under them, by design.
5. **One shut state per Home (XS).** The restoring set and the deleting set become one `Map<ownerId, ApiError>` with `shutHome(ownerId, refusal)` and `reopenHome(ownerId)`; `openHome` throws the stored error. The backup job slot stays as the "one backup job per home" rule. Touches backup code, so it waits for backup-safety to land, and lands after its fix that runs a restore's refusals before the Home goes offline.
6. **Container databases count their holders (S).** A `holders` count on `DocumentDbSlot`, a `mount.withDatabase(config, pathId, fn)` that the readers above use instead of opening and keeping, and a `closeDatabase` that waits for zero holders with a short linger. Fixes the readers that keep databases open and the chat request racing a version restore. Keep the order `document-db.ts` documents, container path lock, then slot, then tree lock, on every path. A reader must not hold a database while it waits for the path lock: `ChatRoom.init` takes that lock, and `replaceContainerDataDb` takes it before the database, so a held reader and a restore would wait on each other.

Steps 2, 4 and 6 touch no backup or SSE code and can start before backup-safety lands. Steps 1, 3 and 5 wait for it.

## What it leaves unsolved

The idle timer stays a guess for a short request that is neither a connection nor a long request; such a request is quick, so the guess is safe in practice. Three mechanisms stay three (Home holds, collab lingers, container-db holders), each simpler than today. A restore or deletion still evicts under a short request in flight, which then gets a clean 503. The FD budget proposal gets its "in use" answer for free: after steps 3 and 4, `holds > 0` means a connection or a long request.

## Decisions for the owner

None of the steps adds a route, a migration, a package or a stored format. One open product question decides whether the generic primitive is ever worth it: should a collab or container close still take a version snapshot (`skipFinalSnapshot` is threaded through five layers to turn it off), or should versions come only from edits and explicit saves? Answer it before revisiting the primitive.
