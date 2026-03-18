# Backend Review: Collab (Yjs, WebSocket, Real-time Editing)

**Scope:** `apps/api/src/lib/collab/`, `apps/api/src/routes/collab.ts`, `apps/api/src/routes/editor.ts`,
`apps/api/src/utils/singleton.ts`, `apps/api/src/utils/websockets.ts`
**Reviewed:** 2026-03-18

## Summary

The collab domain provides server-side Yjs document hosting for eigendoc, eigenstickies, eigenslides, and eigensheets.
Each document is backed by a SQLite database (`data.db`) inside the Drive mount, storing incremental Yjs updates and
periodic snapshots. WebSocket connections carry the Yjs sync protocol (sync + awareness messages). An inner `DbProvider`
class handles persistence, snapshots, and revision history. A separate `editor.ts` route handles inline editing of plain
text/markdown files (no Yjs).

Key files:
- `apps/api/src/lib/collab/collabDocument.ts` -- `CollabDocument` class (WebSocket handling) + `DbProvider` (persistence)
- `apps/api/src/lib/collab/schema.ts` -- `doc_updates` and `doc_snapshots` tables
- `apps/api/src/lib/collab/db-config.ts` -- migration for collab database
- `apps/api/src/routes/collab.ts` -- REST endpoints (info, revisions) + WebSocket endpoint
- `apps/api/src/routes/editor.ts` -- REST-only inline text file editing

## Critical Issues

### 1. Document updates are never broadcast to other connected clients

`apps/api/src/lib/collab/collabDocument.ts`, `handleMessage()` (lines 243-311)

When a client sends a Yjs SyncStep2 (type 1) or Update (type 2) message, `readSyncMessage()` at line 263 calls
`Y.applyUpdate(doc, data, transactionOrigin)` inside y-protocols. This fires the Y.Doc's `update` event. The only
listener is `DbProvider.updateHandler` (registered at line 39), which calls `storeUpdate()` to persist to SQLite.

There is no listener that broadcasts the update to other connected WebSocket clients. The comment on line 276 --
_"No need to broadcast - updates trigger the doc's 'update' event which is handled separately"_ -- is incorrect.
The `update` event only triggers DB persistence, not network broadcast.

Verified by tracing the full y-protocols flow:
1. Client sends `[MESSAGE_SYNC(0), SyncStep2(1), updateData...]` or `[MESSAGE_SYNC(0), Update(2), updateData...]`
2. `handleMessage` reads MESSAGE_SYNC, then calls `syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn)`
3. `readSyncMessage` (y-protocols/sync.js line 118) reads the sub-type, dispatches to `readSyncStep2` or `readUpdate`
4. Both call `Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), transactionOrigin)`
5. Y.Doc fires `update` event
6. `DbProvider.updateHandler` stores to DB -- but nobody sends to other WebSocket clients
7. `readSyncMessage` writes nothing to the encoder for SyncStep2/Update messages
8. `encoding.length(encoder) > 1` is false (only the MESSAGE_SYNC byte from line 260), so no response is sent
9. The originating client gets no ack, and no other client gets the update

Awareness messages ARE correctly broadcast (lines 301-308). Document content updates are not.

**Impact**: Multi-user real-time collaboration is non-functional. Changes made by one user are persisted server-side but
never delivered to other connected clients. Users only see each other's edits after reconnecting (when the initial sync
loads the full document state from DB).

**Fix**: Register a `doc.on('update', ...)` handler in `CollabDocument` (not DbProvider) that encodes the update as a
Yjs sync message and calls `broadcastMessage`. The `transactionOrigin` passed by `readSyncMessage` is `conn` (the
sending WebSocket), so it can be used to exclude the sender:

```typescript
this.doc.on('update', (update: Uint8Array, origin: any) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    if (origin instanceof ServerWebSocket) {
        this.broadcastMessage(origin, message);
    } else {
        for (const conn of this.connections) {
            if (conn.readyState === 1) conn.send(Buffer.from(message));
        }
    }
});
```

### 2. Awareness removal on disconnect is never broadcast to remaining clients

`apps/api/src/lib/collab/collabDocument.ts`, `unsubscribe()` (lines 213-241)

When a user disconnects, `removeAwarenessStates()` is called (line 221) to clean up their awareness data. This emits
`change` and `update` events on the `Awareness` object (verified in y-protocols/awareness.js lines 184-185). However,
`CollabDocument` never registers a listener on `awareness.on('update', ...)`.

This means remaining clients are never notified that a user has left. Their cursors/selections/presence indicators
remain visible as ghost data until the client-side awareness timeout fires (typically 30 seconds).

The y-websocket reference implementation handles this by listening to awareness `update` events and broadcasting them.

**Fix**: In `init()`, register:

```typescript
this.awareness.on('update', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }, origin: any) => {
    const changedClients = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
    const message = encoding.toUint8Array(encoder);
    // broadcast to all except origin (if origin is a WebSocket)
    for (const conn of this.connections) {
        if (conn !== origin && conn.readyState === 1) {
            conn.send(Buffer.from(message));
        }
    }
});
```

## Important Issues

### 3. Snapshot creation can lose concurrent updates

`apps/api/src/lib/collab/collabDocument.ts`, `createSnapshot()` (lines 82-115)

The snapshot flow performs four separate DB operations without a transaction:
1. Encodes current doc state (line 84)
2. Gets the last update ID (lines 86-89)
3. Inserts the snapshot referencing that ID (lines 93-96)
4. Deletes ALL updates unconditionally: `this.db.delete(schema.docUpdates).run()` (line 98)

If a new update is stored between steps 2 and 4, it gets deleted without being captured in the snapshot. While
JavaScript is single-threaded, the Y.Doc `update` event can fire during `createSnapshot` if another message is processed
in between (though in practice this is unlikely since `storeUpdate` triggers `createSnapshot` synchronously).

The more concrete concern is that the DELETE has no WHERE clause. It deletes all updates, not just those up to
`lastUpdate.id`. If any update is inserted after step 2 (e.g., from a different async context or a race during snapshot
creation triggered by `destroy()`), it is silently lost.

**Fix**: Use a bounded delete: `this.db.delete(schema.docUpdates).where(lte(schema.docUpdates.id, lastUpdate.id)).run()`

### 4. Per-message permission checks cause unnecessary DB overhead

`apps/api/src/routes/collab.ts`, `message` handler (lines 102-135)

Every WebSocket message triggers:
- `getSharedDrive(ownerId, user)` -- resolves Home + potentially creates SharedDrive
- `drive.canRead(mountId, pathId, user)` -- DB query to check ACL
- `drive.getCollabDocument(mountId, pathId)` -- singleton lookup (fast, but SharedDrive adds a permission check)
- `drive.canWrite(mountId, pathId, user)` -- another DB query for ACL

For a document with active editing, this means 2-3 DB queries per keystroke per user. The document reference and write
permission were already resolved at connection time in the `open` handler.

**Fix**: Store the `CollabDocument` instance and `canWrite` boolean on the WebSocket data object during `open`. In the
`message` handler, read from `ws.data` instead of re-resolving. This reduces per-message cost to zero DB queries.

Note: the per-message `canWrite` check does have value for live permission changes (downgrading a user to read-only
while they're connected), but this could be handled by invalidating cached permissions via an event rather than
re-querying every message.

### 5. `createAsyncSingleton` never recovers from initialization failure

`apps/api/src/utils/singleton.ts`

If the factory function rejects, `initializationPromise` is set to the rejected promise but `instance` remains null.
On subsequent calls, `initializationPromise` is not null, so the same rejected promise is returned forever. A transient
error (e.g., temporary DB lock, file system hiccup) permanently breaks the singleton.

For `Drive.documents` (the collab document map), there is no cleanup path: if `CollabDocument.init()` fails once, that
document is permanently inaccessible until server restart. For `getHome`, the `cleanupHomeFactory` function can remove
the map entry, but the singleton inside the old map entry is still broken.

**Fix**: Reset `initializationPromise` on rejection:

```typescript
initializationPromise = factoryFn().then(result => {
    instance = result;
    return result;
}).catch(err => {
    initializationPromise = null;
    throw err;
});
```

### 6. Double-unsubscribe can initialize a new document unnecessarily

`apps/api/src/routes/collab.ts`, `close` handler (lines 137-160) vs `keepWebSocketAlive` callback (lines 89-95)

Both the WebSocket `close` handler and the `keepWebSocketAlive` interval-based onClose callback call unsubscribe on
disconnect. When the first one fires and it's the last connection, `unsubscribe` calls `drive.closeCollabDocument()`,
which calls `destruct()` and removes the singleton from `Drive.documents`.

When the second one fires:
- The `keepWebSocketAlive` callback captured the document instance at `open` time, so it calls `document.unsubscribe()`
  directly. The `this.closed` guard (line 215) makes this a no-op. Safe.
- The `close` handler re-resolves `getCollabDocument(mountId, pathId)`. Since the old entry was deleted from
  `Drive.documents`, this creates a NEW `CollabDocument`, opens a new Y.Doc, loads state from DB -- then immediately
  calls `unsubscribe()` on this fresh document. The new document has 0 connections and triggers `closeCollabDocument()`
  again.

In the normal case (`close` fires first, interval fires later), the interval hits the `this.closed` guard. But if the
interval fires first, the `close` handler does the wasteful re-init.

**Fix**: Either (a) have `keepWebSocketAlive` return the interval ID so the `close` handler can clear it, or (b) have
the `close` handler skip unsubscribe if already done (track a per-connection "cleaned up" flag on `ws.data`).

### 7. Collab document database is never closed

`apps/api/src/lib/collab/collabDocument.ts`, `destruct()` (lines 192-202) and
`apps/api/src/lib/drive/drive.ts`, `closeCollabDocument()` (lines 496-510)

When a `CollabDocument` is destructed (last user disconnects), `DbProvider.destroy()` unregisters the update handler
and creates a final snapshot, then `CollabDocument.destruct()` destroys the Y.Doc and Awareness. But neither calls
`mount.closeDatabase(dataDbPathId)`.

The `ManagedDatabase` stays open with its sync timer (`setInterval`) still running. Over time, if many documents are
opened and closed, this leaks file handles and timers. The database is reusable if the document is reopened (since
`mount.openDatabase` returns the existing singleton), so this is not a correctness issue, but it is a resource leak.

**Fix**: `closeCollabDocument` should call `mount.closeDatabase(dataDbPathId)` after `destruct()`. The `dataDbPathId`
would need to be stored on the `CollabDocument` or resolved at close time.

## Minor Issues

### 8. Deprecated `new Buffer()` usage

`apps/api/src/lib/collab/collabDocument.ts`, line 273

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated. The rest of the file correctly uses `Buffer.from()` (lines 322, 343, 360). This should
be `Buffer.from(responseMessage)`.

### 9. Excessive console.log in production code paths

`apps/api/src/lib/collab/collabDocument.ts`, lines 153, 163, 210, 225, 236, 344, 361

Every document creation, init, subscribe, unsubscribe, sync step, and awareness send produces console output. For a
system with many concurrent users, this generates significant log noise. Consider a debug flag or structured logger.

### 10. `revisionId` parameter not validated

`apps/api/src/routes/collab.ts`, line 46

```typescript
const state = document.getRevisionState(parseInt(params.revisionId, 10));
```

`parseInt` with a non-numeric string returns `NaN`, which passes to the DB query and returns no result (caught by the
404 check). Not a security issue but untidy. Use Elysia's `t.Numeric()` in the route params.

### 11. `@ts-ignore` comments suppress type safety

`apps/api/src/routes/collab.ts`, lines 68, 103, 139

Three `@ts-ignore` comments for `ws.data?.user`. This suggests a typing issue with Elysia's WebSocket `data` type that
should be resolved with proper generics rather than suppressed.

### 12. Modifying Set during iteration in `destruct`

`apps/api/src/lib/collab/collabDocument.ts`, lines 195-198

```typescript
for (const conn of this.connections) {
    conn.close();
    this.connections.delete(conn);
}
```

Deleting from a Set while iterating is allowed by the JS spec but fragile. Prefer closing all connections first, then
clearing: iterate to close, then call `this.connections.clear()`.

### 13. WebSocket `close` handler calls `ws.close()` on already-closing socket

`apps/api/src/routes/collab.ts`, line 142

Inside the `close` handler, `ws.close(1008, ...)` is called if user is null. But the WebSocket is already closing
(that's why the handler fired). This is a no-op but confusing.

### 14. `getSharedDrive` null check is dead code

`apps/api/src/routes/collab.ts`, line 125

```typescript
if (!drive || !(await drive.canRead(mountId, pathId, user))) {
```

`getSharedDrive` never returns null -- it throws `ApiError(401)` if user is missing, or returns a Drive/SharedDrive
instance. The `!drive` check is dead code.

### 15. Stale connection cleanup during `unsubscribe` modifies Set during iteration

`apps/api/src/lib/collab/collabDocument.ts`, lines 226-234

The stale connection cleanup loop iterates `this.connections` and calls `this.connections.delete(connection)` inside the
loop. Same issue as #12 -- works but fragile.

## Observations

### Architecture compliance

| Rule | Status | Notes |
|------|--------|-------|
| Domain class in `lib/collab/` | Pass | `CollabDocument` + `DbProvider` |
| Route in `routes/collab.ts` | Pass | Thin router with auth |
| DB schema in `lib/collab/schema.ts` | Pass | |
| DB config in `lib/collab/db-config.ts` | Pass | |
| Auth via `{auth: true}` | Pass | All REST endpoints; WebSocket checks in `open` handler |
| `type` over `interface` | Pass | |
| English everywhere | Pass | |
| No JSDoc | Pass | |

### Write-permission enforcement

The read-only check in `handleMessage` (lines 253-255) uses `decoding.peekUint8(decoder)` to inspect the sync sub-type
without advancing the decoder position. It blocks sub-types 1 (SyncStep2) and 2 (Update) for read-only users while
allowing sub-type 0 (SyncStep1, state request). This is correct.

The use of `peekUint8` (raw byte) versus `readVarUint` (variable-length) is safe because sync sub-type values 0, 1, 2
are all single-byte varuints.

### Robustness

| Area | Assessment |
|------|------------|
| **Document content sync** | **Broken** -- updates stored but never broadcast to peers |
| **Awareness sync** | **Partially broken** -- incoming awareness broadcasts work; disconnect removal does not broadcast |
| **Persistence** | Good -- incremental updates + periodic snapshots with revision history |
| **State recovery on restart** | Good -- loads latest snapshot + subsequent updates |
| **Permission enforcement** | Correct but expensive (per-message DB queries) |
| **Memory management** | Resource leak -- ManagedDatabase never closed after document close |
| **Error recovery** | Weak -- singleton errors are permanent for collab documents |
| **Cleanup on disconnect** | Works but has double-unsubscribe overhead and potential re-init |

### Test coverage

File: `apps/api/src/test/collab.test.ts` (418 lines)

| Category | Tests | Assessment |
|----------|-------|------------|
| Auth enforcement | 2 | Good |
| Info endpoint | 3 | Good |
| WebSocket connection | 4 | Adequate |
| Document updates | 4 | Weak -- conditional on `wsRes.status === 101` |
| Permission changes | 2 | Weak -- same conditional pattern |

**Coverage gaps**:
- No test verifies that updates from client A reach client B (would have caught Critical #1)
- No test verifies awareness removal is broadcast on disconnect (would have caught Critical #2)
- No test for revision creation/retrieval after actual Yjs operations
- No test for document cleanup when last user disconnects
- No test for concurrent snapshot creation
- WebSocket tests silently skip via `if (wsRes.status !== 101) return` -- if the test environment doesn't support
  WebSocket upgrade, all behavioral tests pass without executing
- No tests for the editor route

### Editor route (editor.ts)

The editor route is separate from the Yjs collab system and handles inline editing of plain text/markdown files via
REST. It uses optimistic concurrency control via `expectedUpdatedAt` comparison. It properly validates file type, size,
and UTF-8 encoding. For shared drives, `getSharedDrive` returns a `SharedDrive` which checks permissions in `getPath`
(read) and `writeFileContent` (write). The frontmatter preservation logic is clean.

No issues found beyond the scope of this review.
