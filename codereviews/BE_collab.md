# Backend Review: Collab (Yjs, WebSocket, Real-time Editing)

**Scope:** `apps/api/src/lib/collab/`, `apps/api/src/routes/collab.ts`, `apps/api/src/routes/editor.ts`,
`apps/api/src/utils/singleton.ts`, `apps/api/src/utils/websockets.ts`
**Reviewed:** 2026-03-19

## Summary

The collab domain provides server-side Yjs document hosting for eigendoc, eigenstickies, eigenslides, and eigensheets.
Each collaborative document is backed by a SQLite database (`data.db`) inside the Drive mount, storing incremental Yjs
updates and periodic snapshots. WebSocket connections carry the Yjs sync protocol (sync + awareness messages). An inner
`DbProvider` class handles persistence, snapshots, and revision history. A separate `editor.ts` route handles inline
editing of plain text/markdown files (no Yjs).

Key files:
- `apps/api/src/lib/collab/collabDocument.ts` -- `CollabDocument` class (WebSocket handling) + `DbProvider` (persistence)
- `apps/api/src/lib/collab/schema.ts` -- `doc_updates` and `doc_snapshots` tables
- `apps/api/src/lib/collab/db-config.ts` -- migration for collab database
- `apps/api/src/routes/collab.ts` -- REST endpoints (info, revisions) + WebSocket endpoint
- `apps/api/src/routes/editor.ts` -- REST-only inline text file editing
- `apps/api/src/utils/websockets.ts` -- `keepWebSocketAlive` ping utility
- `apps/api/src/utils/singleton.ts` -- `createAsyncSingleton` factory
- `apps/api/src/test/collab.test.ts` -- integration tests

## Architecture Overview

### CollabDocument lifecycle

1. **Creation**: `CollabDocument.create()` touches `data.db`, creates `media/` and `chat/` folders inside the Drive
   document folder.
2. **Initialization**: `init()` opens the `data.db` via `Drive.openDatabase()`, creates a `Y.Doc`, instantiates a
   `DbProvider` (which loads persisted state), sets up an `Awareness`, and registers two event listeners:
    - `doc.on('update')` -- broadcasts sync updates to connected WebSocket clients
    - `awareness.on('update')` -- broadcasts awareness changes (cursors, selections) to other clients
3. **Singleton management**: `Drive.getCollabDocument()` wraps init in `createAsyncSingleton()` keyed by
   `{ownerId}.{mountId}.{pathId}`. Multiple concurrent callers get the same instance.
4. **Teardown**: When the last WebSocket disconnects, `unsubscribe()` calls `drive.closeCollabDocument()`, which calls
   `destruct()` (creates a final snapshot, destroys Y.Doc + Awareness), removes the singleton from the map, and closes
   the `ManagedDatabase`.

### WebSocket protocol

Messages use the Yjs binary protocol with two message types:

- `MESSAGE_SYNC (0)` -- Yjs sync protocol (SyncStep1/SyncStep2/Update sub-types)
- `MESSAGE_AWARENESS (1)` -- Awareness protocol (cursor positions, user info)

On WebSocket open, the server sends SyncStep1 (state vector) and current awareness state to the new client. The client
responds with SyncStep2 (its missing updates). Subsequent updates flow through `handleMessage()`.

### DbProvider persistence model

Incremental updates are stored in `doc_updates`. Every 100 updates (`SNAPSHOT_INTERVAL`), a full document snapshot is
written to `doc_snapshots` and the corresponding updates are pruned. Up to 50 snapshots (`MAX_REVISIONS`) are retained
as revision history. On load, the latest snapshot is applied, then any subsequent incremental updates.

### Write permission enforcement

Read-only users can connect and receive updates but cannot send SyncStep2 or Update messages. The check in
`handleMessage()` uses `decoding.peekUint8()` to inspect the sync sub-type without advancing the decoder, blocking
sub-types 1 and 2 for read-only users while allowing sub-type 0 (SyncStep1 state requests).

## Critical Issues

### 1. Missing `await` on `closeCollabDocument` in `unsubscribe` -- fire-and-forget async call

`apps/api/src/lib/collab/collabDocument.ts`, line 265

```typescript
public unsubscribe(_user: User, conn: ServerWebSocket<any>) {
    // ...
    if (this.connections.size <= 0) {
        this.drive.closeCollabDocument(this.path.mountId, this.path.id);  // NOT awaited
    }
}
```

`Drive.closeCollabDocument()` is an async method (line 514 of `drive.ts`). It calls `doc.destruct()` (synchronous),
deletes the singleton from the map, and then calls `await mount.closeDatabase(doc.dataDbPathId)` (async). Since
`unsubscribe()` is synchronous and does not await this call, the async `mount.closeDatabase()` floats as an unhandled
promise.

CLAUDE.md explicitly calls this out: _"Always `await` async calls -- missing `await` is the #1 bug class in this
codebase. A bare async call returns a truthy Promise, silently skipping the intended logic."_

**Consequences:**

- `mount.closeDatabase()` may not complete before the next access, leading to a race where a new `getCollabDocument()`
  call opens a new singleton while the old database is still closing.
- If `mount.closeDatabase()` throws (e.g., sync failure on S3 storage), the error is swallowed as an unhandled promise
  rejection -- no error logging, no retry.
- With S3 storage backends, the final upload of the database file may be silently skipped.

**Fix:** Make `unsubscribe` async and await the close call. Update all callers (`close` handler, `keepWebSocketAlive`
callback) to handle the returned promise. Alternatively, chain `.catch()` to at least capture the error:

```typescript
this.drive.closeCollabDocument(this.path.mountId, this.path.id)
    .catch(err => console.error(`Failed to close collab document:`, err));
```

## Important Issues

### 2. Per-message permission re-query causes unnecessary DB overhead

`apps/api/src/routes/collab.ts`, lines 136-137

```typescript
const drive = await getSharedDrive(ownerId, user);
const canWrite = await drive.canWrite(mountId, pathId, user);
```

Every single WebSocket message triggers `getSharedDrive()` (resolves Home, potentially creates SharedDrive) and
`canWrite()` (DB query to check ACL). For active editing, this means at least 2 async operations per keystroke per user.

The document reference is already cached on `ws.data.collabDocument` (lines 127-134), but write permission is
re-checked unconditionally every message.

**Why this matters:** Collaborative editing can generate dozens of messages per second per user. With N concurrent
editors, this is 2N DB queries per second just for permission checks on data that rarely changes.

**Fix:** Cache the `canWrite` result on `ws.data` during `open`. For live permission downgrades, either:
(a) Re-check periodically (e.g., every 30 seconds) rather than every message, or
(b) Push a permission-invalidation event when ACL changes, clearing the cached value.

### 3. Snapshot creation is not wrapped in a transaction

`apps/api/src/lib/collab/collabDocument.ts`, `createSnapshot()` (lines 82-117)

The snapshot flow performs four separate DB operations:

1. Encode current doc state (line 84)
2. Query the last update ID (lines 86-89)
3. Insert the snapshot (lines 93-96)
4. Delete updates up to `lastUpdate.id` (lines 98-100)

These are not wrapped in a SQLite transaction. If the process crashes between step 3 (snapshot inserted) and step 4
(updates deleted), both the snapshot and the updates exist -- this is safe (just wastes space). But if a crash occurs
between step 4 (updates deleted) and step 3 (snapshot not yet inserted), updates are lost without a snapshot. Since
SQLite calls in Bun are synchronous and JS is single-threaded, the only real risk is a process kill signal between two
synchronous DB calls, which is unlikely but possible.

The old snapshot pruning (lines 102-111) has the same non-transactional pattern but is even lower risk since it only
deletes excess snapshots.

**Fix:** Wrap steps 2-4 in a SQLite transaction using `db.transaction()`:

```typescript
this.db.transaction((tx) => {
    const lastUpdate = tx.select(...).get();
    if (!lastUpdate) return;
    tx.insert(schema.docSnapshots).values({ stateData, lastUpdateId: lastUpdate.id }).run();
    tx.delete(schema.docUpdates).where(lte(schema.docUpdates.id, lastUpdate.id)).run();
});
```

### 4. `keepWebSocketAlive` interval is never cleared on normal WebSocket close

`apps/api/src/utils/websockets.ts`

The ping interval (15s) is only cleared when a ping fails or the socket is detected as non-OPEN inside the interval
callback. When a WebSocket closes normally (triggering the route's `close` handler), the interval continues running for
up to 15 more seconds. On the next tick it detects the closed state, clears itself, and calls `onClose()` which checks
`collabCleaned` and is a no-op.

This means every WebSocket close leaks a timer for up to 15 seconds. With many concurrent users connecting and
disconnecting, this creates unnecessary timer churn.

**Fix:** Return the interval ID from `keepWebSocketAlive` and store it on `ws.data` so the `close` handler can call
`clearInterval()`:

```typescript
export function keepWebSocketAlive(...): NodeJS.Timer {
    const pingInterval = setInterval(...);
    return pingInterval;
}

// In open handler:
ws.data.pingInterval = keepWebSocketAlive(user, rawWs, cleanup);

// In close handler:
clearInterval(ws.data.pingInterval);
```

### 5. Awareness clientId tracking silently ignores parsing errors

`apps/api/src/lib/collab/collabDocument.ts`, lines 312-325

```typescript
try {
    const trackDecoder = decoding.createDecoder(awarenessUpdate);
    const len = decoding.readVarUint(trackDecoder);
    if (!this.connectionClientIds.has(conn)) {
        this.connectionClientIds.set(conn, new Set());
    }
    const ids = this.connectionClientIds.get(conn)!;
    for (let i = 0; i < len; i++) {
        ids.add(decoding.readVarUint(trackDecoder));
    }
} catch {
    // ignore parsing errors
}
```

The awareness update binary format contains `[len, ...(clientId, clock, stateJSON)*]`. This code reads `len` client IDs
but then reads them as raw varuints, skipping over the `clock` and `stateJSON` fields for each entry. After the first
clientId, the second `readVarUint` reads the clock value, not the next clientId.

The parsing is incorrect for messages with more than one client. However, since awareness updates are typically
single-client (each client sends its own state), this usually works in practice. The `catch {}` silently swallows
parsing errors from multi-client awareness updates.

If clientIds are not tracked correctly, `removeAwarenessStates` on disconnect may miss some IDs, leaving ghost cursors
until the client-side timeout fires (typically 30s).

**Fix:** Parse the full awareness update format:
```typescript
for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(trackDecoder);
    decoding.readVarUint(trackDecoder);          // clock
    decoding.readVarString(trackDecoder);         // state JSON
    ids.add(clientId);
}
```

Or simpler: use `awarenessProtocol.decodeAwarenessUpdate()` if available, or just track clientIds from the applied
awareness state changes rather than parsing the raw binary.

### 6. `resyncInterval: 5000` is redundant now but still generates polling traffic

All four frontend apps (docs, stickies, slides, sheets) still configure `resyncInterval: 5000`:

- `apps/docs/src/components/docs/editor.tsx:57`
- `apps/stickies/src/components/stickies/hooks/use-board.ts:99`
- `apps/slides/src/components/slides/hooks/use-deck.ts:77`
- `apps/sheets/src/components/sheets/hooks/use-sheet.ts:62`

Now that the server broadcasts updates instantly via the `doc.on('update')` handler (line 182), the 5-second resync is
redundant for normal operation. Every 5 seconds, each connected client sends a SyncStep1 (its full state vector) and the
server responds with a SyncStep2 (empty if no diff). With N concurrent users on a document, this generates 2N
unnecessary messages every 5 seconds.

**Fix:** Increase `resyncInterval` to 30-60 seconds as a fallback recovery mechanism. The primary sync path is now the
server-side broadcast.

## Minor Issues

### 7. Deprecated `new Buffer()` usage

`apps/api/src/lib/collab/collabDocument.ts`, line 299

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated in Node.js. The rest of the file correctly uses `Buffer.from()` (lines 191, 205, 348, 369).
This should be `Buffer.from(responseMessage)` for consistency.

### 8. Modifying `Set` during iteration in `unsubscribe`

`apps/api/src/lib/collab/collabDocument.ts`, lines 253-261

```typescript
for (const connection of this.connections) {
    if (connection.readyState > 1) { // CLOSING or CLOSED
        this.connections.delete(connection);
        // ...
    }
}
```

Deleting from a Set while iterating is allowed by the JS spec (the deleted element won't be visited again, and elements
not yet visited will still be visited). But it is fragile and non-obvious to future maintainers. The same pattern
appears
in `destruct()` (lines 224-227):

```typescript
for (const conn of this.connections) {
    conn.close();
    this.connections.delete(conn);
}
```

**Fix:** Collect items to remove, then delete after iteration. Or in `destruct()`, iterate then call
`this.connections.clear()`.

### 9. `revisionId` parameter not validated as numeric

`apps/api/src/routes/collab.ts`, line 46

```typescript
const state = document.getRevisionState(parseInt(params.revisionId, 10));
```

`parseInt` with a non-numeric string returns `NaN`, which passes to the DB query and returns no result (caught by the
404 check). Not a security issue but untidy. Use Elysia's `t.Numeric()` in the route params for proper validation.

### 10. Twelve `@ts-ignore` comments in collab route

`apps/api/src/routes/collab.ts`, lines 66, 85, 87, 91, 93, 115, 126, 132, 145, 147, 150, 152

Every access to `ws.data.user`, `ws.data.collabDocument`, and `ws.data.collabCleaned` requires `@ts-ignore` because
Elysia's WebSocket `data` type does not include these custom fields. This suppresses TypeScript's type safety across the
entire WebSocket handler.

**Fix:** Extend the WebSocket data type via Elysia's generic parameters or declare a custom type and use
`ws.data as CustomType` once at the top of each handler, rather than scattering `@ts-ignore` across 12 locations.

### 11. `getSharedDrive` null check is dead code

`apps/api/src/routes/collab.ts`, lines 76, 130

```typescript
if (!drive || !(await drive.canRead(mountId, pathId, user))) {
```

`getSharedDrive()` never returns null -- it either returns a `Drive`/`SharedDrive` instance or throws an `ApiError`.
The `!drive` check is dead code and obscures the actual error path.

### 12. `doc.gc = true` prevents cross-session undo history

`apps/api/src/lib/collab/collabDocument.ts`, line 178

```typescript
this.doc.gc = true;
```

With garbage collection enabled, deleted content is permanently removed from the CRDT structure. This is the correct
default for production (prevents unbounded document growth), but it means that Yjs undo history does not survive across
sessions. If a future requirement needs persistent undo history (e.g., restoring deleted content from a previous
editing session), this would need to be changed. Not a bug, but worth documenting.

## Strengths

### Correct broadcast architecture

The `doc.on('update')` handler (line 182) correctly broadcasts updates to all connected clients, using the
`transactionOrigin` to exclude the sender. The origin check (`'readyState' in origin`) correctly identifies WebSocket
origins vs. internal origins (like loading from DB). This is the standard y-websocket broadcast pattern.

### Awareness broadcast on disconnect

The `awareness.on('update')` handler (line 196) correctly broadcasts awareness changes to all clients except the
origin. When a user disconnects, `removeAwarenessStates()` in `unsubscribe()` triggers this handler, notifying
remaining clients immediately (no ghost cursor timeout needed).

### Sound singleton lifecycle

The `createAsyncSingleton` pattern (with the `.catch` reset on line 22-24 of `singleton.ts`) correctly handles
transient initialization failures -- a failed init clears the promise so the next caller retries. The collab document
map in `Drive.documents` combined with `closeCollabDocument` removing the entry provides clean lifecycle management.

### Clean read-only enforcement

The `peekUint8` approach to checking sync sub-types (line 279-281) is elegant -- it inspects without consuming, so the
decoder remains valid for `readSyncMessage`. The sub-type values 0, 1, 2 are all single-byte varuints, so `peekUint8`
and `readVarUint` are equivalent for these values.

### Database close on document teardown

`Drive.closeCollabDocument()` (line 514-527) correctly calls `mount.closeDatabase(doc.dataDbPathId)` after
`destruct()`, preventing the `ManagedDatabase` and its sync timer from leaking. The `dataDbPathId` is stored as a
public field on `CollabDocument` for this purpose.

### Bounded update/snapshot storage

The snapshot interval (100 updates) and max revisions (50 snapshots) provide bounded storage growth. Old updates are
pruned on snapshot creation, and excess snapshots are pruned beyond `MAX_REVISIONS`. The bounded delete
(`where(lte(...))` on line 99) correctly preserves any updates that arrive after the snapshot cutoff.

### Double-unsubscribe guard

The `collabCleaned` flag on `ws.data` (set in both the `close` handler and the `keepWebSocketAlive` callback) prevents
the double-unsubscribe problem where both cleanup paths fire. Whichever fires first sets the flag; the second is a
no-op.

### Editor route: clean optimistic concurrency

The `editor.ts` route uses `expectedUpdatedAt` comparison for conflict detection on plain text/markdown saves. It
properly handles frontmatter preservation, UTF-8 validation, file size limits, and MIME type checking. The `force`
flag allows overriding conflicts when the user explicitly chooses to.

## Test Coverage

**File:** `apps/api/src/test/collab.test.ts` (418 lines)

| Category             | Tests | Assessment                                                      |
|----------------------|-------|-----------------------------------------------------------------|
| Auth enforcement     | 2     | Good -- tests unauthenticated access to both REST and WebSocket |
| Info endpoint        | 3     | Good -- tests owner access, no-permission, shared read          |
| WebSocket connection | 4     | Adequate -- tests auth, read permission, ping-pong              |
| Document updates     | 4     | Conditional -- tests gated by `wsRes.status === 101`            |
| Permission changes   | 2     | Conditional -- same gating pattern                              |

### Coverage gaps

- **Conditional execution**: All WebSocket behavioral tests use `if (wsRes.status !== 101) return`. If the test
  environment does not support WebSocket upgrade, these tests silently pass without executing any assertions. This
  means the entire WebSocket protocol, broadcast behavior, and permission enforcement may be untested in CI.

- **No broadcast verification**: No test verifies that an update from Client A arrives at Client B via the server
  broadcast (as opposed to polling). The multi-user sync test (line 235) would catch this, but only if WebSocket
  upgrade succeeds.

- **No revision lifecycle test**: No test creates actual Yjs content, triggers a snapshot, and then retrieves it via
  the revisions API. The revision endpoints are tested only for existence, not correctness.

- **No document cleanup test**: No test verifies that the `CollabDocument` is properly destructed when the last user
  disconnects, or that the database is closed.

- **No editor route tests**: The `editor.ts` route (inline text editing) has zero test coverage.

- **No concurrent access test**: No test exercises multiple simultaneous connections modifying the document
  concurrently to verify CRDT convergence through the server.

## Robustness Assessment

| Area                          | Rating                | Notes                                                                                                       |
|-------------------------------|-----------------------|-------------------------------------------------------------------------------------------------------------|
| **Document content sync**     | Good                  | Updates broadcast instantly via `doc.on('update')` handler                                                  |
| **Awareness sync**            | Good                  | Awareness changes broadcast via `awareness.on('update')` handler; disconnect removal broadcasts immediately |
| **Persistence**               | Good                  | Incremental updates + periodic snapshots with bounded revision history                                      |
| **State recovery on restart** | Good                  | Loads latest snapshot + subsequent updates; handles empty DB gracefully                                     |
| **Permission enforcement**    | Correct but expensive | Per-message DB query for write permission; read-only enforcement is correct                                 |
| **Memory management**         | Good                  | Database closed on document teardown; singleton cleanup works                                               |
| **Error recovery**            | Good                  | Singleton retries on transient failures; errors logged with context                                         |
| **Cleanup on disconnect**     | Good                  | `collabCleaned` flag prevents double-unsubscribe; awareness cleaned up                                      |
| **Missing await**             | Bug                   | `closeCollabDocument` not awaited in `unsubscribe` (Critical #1)                                            |
| **Timer cleanup**             | Minor leak            | `keepWebSocketAlive` interval not cleared on normal close                                                   |

## Related Files

- `apps/api/src/lib/drive/drive.ts` -- `getCollabDocument()` (line 498), `closeCollabDocument()` (line 514),
  `closeCollabDocumentsRecursively()` (line 684)
- `apps/api/src/lib/drive/sharedDrive.ts` -- `getCollabDocument()` (line 95), `closeCollabDocument()` (line 102) --
  delegates to underlying Drive with permission checks
- `apps/api/src/lib/drive/get-drive.ts` -- `getSharedDrive()` resolves Drive/SharedDrive by ownerId
- `apps/api/src/utils/singleton.ts` -- `createAsyncSingleton()` with retry-on-failure
- `apps/api/src/utils/websockets.ts` -- `keepWebSocketAlive()` ping interval
- `packages/lib/src/types/collab.ts` -- `CollabDocumentInfo`, `CollabRevision` types
- `packages/lib/src/core/collab/hooks/use-collab.ts` -- Frontend hooks (`useCollabDocumentInfo`, `useCollabRevisions`)
- `apps/docs/src/components/docs/editor.tsx` -- Docs WebSocket provider setup
- `apps/stickies/src/components/stickies/hooks/use-board.ts` -- Stickies WebSocket provider setup
- `apps/slides/src/components/slides/hooks/use-deck.ts` -- Slides WebSocket provider setup
- `apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- Sheets WebSocket provider setup
- [STICKIES.md](../docs/STICKIES.md), [SLIDES.md](../docs/SLIDES.md), [SHEETS.md](../docs/SHEETS.md) -- App-level collab
  documentation
- [DATABASE.md](../docs/DATABASE.md) -- ManagedDatabase, collab DB config
