# Backend Code Review: Collab (Yjs, WebSocket, Editor)

## Summary

The collab domain handles collaborative real-time editing for Eigen's document types (eigendoc, eigenstickies,
eigenslides, eigensheets). It consists of:

- **`CollabDocument`** (`apps/api/src/lib/collab/collabDocument.ts`) -- server-side Yjs document with WebSocket
  connections, awareness, and DB-backed persistence via an inner `DbProvider` class.
- **`DbProvider`** (same file, inner class) -- stores incremental Yjs updates to SQLite, periodically compacts into
  snapshots, provides revision history.
- **Schema/config** (`schema.ts`, `db-config.ts`) -- two tables: `doc_updates` (incremental) and `doc_snapshots`
  (compacted state).
- **Collab route** (`apps/api/src/routes/collab.ts`) -- REST endpoints for doc info/revisions + WebSocket endpoint for
  real-time sync.
- **Editor route** (`apps/api/src/routes/editor.ts`) -- REST-only inline text file editing (markdown/code), unrelated
  to Yjs.

The architecture follows the project patterns: Drive owns document lifecycle, `createAsyncSingleton` ensures
single-init, and `SharedDrive` wraps permission checks. The WebSocket handler uses Bun's native `ServerWebSocket`.

## Architecture Compliance

| Rule | Status | Notes |
|------|--------|-------|
| Domain class in `lib/collab/` | Pass | `CollabDocument` + `DbProvider` |
| Route in `routes/collab.ts` | Pass | Thin router with auth |
| DB schema in `lib/collab/schema.ts` | Pass | Drizzle ORM schema |
| DB config in `lib/collab/db-config.ts` | Pass | Versioned migration |
| Auth via `{auth: true}` | Pass | All REST endpoints |
| Errors via `ApiError` | Partial | Editor uses `ApiError`; collab route uses raw `ws.close()` codes |
| English everywhere | Pass | |
| No JSDoc | Pass | |
| `type` over `interface` | Pass | No interfaces used |

## Issues Found

### Critical

**1. Missing document update broadcast to peers**
`apps/api/src/lib/collab/collabDocument.ts`, lines 250-276

When a client sends a Yjs SyncStep2 or Update message, `readSyncMessage()` (line 263) applies the update to the
server's `Y.Doc`. This fires the doc's `update` event, but the only listener is `DbProvider.updateHandler` (line 36-38)
which persists to DB. There is no mechanism to broadcast the update to other connected WebSocket clients.

The comment on line 276 says _"No need to broadcast - updates trigger the doc's 'update' event which is handled
separately"_ -- but this is incorrect. The `update` event only triggers DB persistence, not network broadcast.

Awareness updates ARE broadcast (line 305), but document content updates are not.

**Impact**: In multi-user editing, changes from one client are stored server-side but never delivered to other connected
clients in real time. Collaboration appears broken for 2+ concurrent editors.

**Fix**: Register an `update` handler on `this.doc` in the `CollabDocument` class (not `DbProvider`) that encodes the
update as a Yjs sync message and calls `broadcastMessage` to all other connections. Something like:

```typescript
// In CollabDocument.init(), after creating the doc:
this.doc.on('update', (update: Uint8Array, origin: any) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    // origin is the connection that sent the update -- exclude it
    if (origin instanceof ServerWebSocket) {
        this.broadcastMessage(origin, message);
    } else {
        // broadcast to all if origin is not a ws (e.g., server-side change)
        for (const conn of this.connections) {
            if (conn.readyState === 1) conn.send(Buffer.from(message));
        }
    }
});
```

Note: the `transactionOrigin` passed to `readSyncMessage` is currently `conn` (the WebSocket), so it can be used as
the origin to exclude.

**2. Snapshot creation has a race condition and deletes all updates unconditionally**
`apps/api/src/lib/collab/collabDocument.ts`, lines 82-115

`createSnapshot()` performs multiple DB operations without a transaction:
1. Encodes current doc state (line 84)
2. Gets the last update ID (line 86-89)
3. Inserts the snapshot with that ID (line 93-96)
4. **Deletes ALL updates** with no WHERE clause (line 98)

If a new update is written between steps 2 and 4, it will be deleted without being included in the snapshot. This
causes silent data loss.

**Fix**: Wrap in a transaction, or change line 98 to only delete updates up to `lastUpdate.id`:
```typescript
this.db.delete(schema.docUpdates).where(lte(schema.docUpdates.id, lastUpdate.id)).run();
```

### Important

**3. Per-message permission check is expensive and redundant**
`apps/api/src/routes/collab.ts`, lines 121-131

Every WebSocket message triggers:
- `getSharedDrive(ownerId, user)` -- resolves/creates Home + SharedDrive
- `drive.canRead(mountId, pathId, user)` -- DB query to check ACL
- `drive.getCollabDocument(mountId, pathId)` -- singleton lookup
- `drive.canWrite(mountId, pathId, user)` -- another DB query for ACL

For a busy document with many edits, this means multiple DB round-trips per keystroke per user. The document reference
and write permission should be resolved once at connection time and cached on the WebSocket data object.

**4. Double unsubscribe on disconnect**
`apps/api/src/routes/collab.ts`, lines 89-95 and 137-160

When a WebSocket disconnects, `unsubscribe` can be called twice:
1. `keepWebSocketAlive` detects the connection is no longer open and calls its `onClose` callback (line 91), which
   calls `document.unsubscribe()`.
2. The WebSocket `close` handler (line 137) also calls `document.unsubscribe()`.

While `unsubscribe` is idempotent for the connection removal (Set.delete is safe), the stale connection cleanup loop
(lines 226-235) runs each time, and if the document triggers `closeCollabDocument` (line 239) on the first call,
the second call re-opens the document via `getCollabDocument` only to unsubscribe from a fresh empty document.

**5. `keepWebSocketAlive` interval is never cleared on normal close**
`apps/api/src/utils/websockets.ts`, lines 4-20

The `setInterval` returned by `keepWebSocketAlive` is only cleared when the ping fails or the readyState is not OPEN.
If the WebSocket closes normally (via `close` handler), the interval continues running until the next 15-second tick
detects the closed state. The function should return the interval ID so the caller can clear it, or use a reference
that can be cleaned up.

**6. Editor route missing explicit permission checks**
`apps/api/src/routes/editor.ts`, lines 25-50 (GET) and 52-84 (PUT)

The GET endpoint calls `drive.getPath()` and `drive.downloadFile()`, and the PUT endpoint calls `drive.getPath()` and
`drive.writeFileContent()`. For the owner's own drive, `getPath` does not check read permissions (it's a direct mount
lookup). For shared drives, `SharedDrive.getPath` checks read permission. However, for the PUT endpoint on the owner's
own drive, `writeFileContent` does check write permission.

For the GET endpoint on the owner's own drive, there are no explicit permission checks before returning file content.
While an owner should have read access to their own files, this is implicit rather than explicit and differs from the
pattern in the collab routes.

**7. `createAsyncSingleton` never resets after error**
`apps/api/src/utils/singleton.ts`

If the factory function throws during initialization, `initializationPromise` is set but `instance` remains null. On
the next call, `initializationPromise` is not null, so it returns the same rejected promise. This means a transient
error (e.g., temporary DB lock) permanently breaks the singleton -- it can never recover.

### Minor

**8. Deprecated `new Buffer()` usage**
`apps/api/src/lib/collab/collabDocument.ts`, line 273

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated. The rest of the file correctly uses `Buffer.from()` (lines 322, 341, 360). This line
should be `Buffer.from(responseMessage)` for consistency.

**9. Inconsistent `Buffer.from` vs `new Buffer` for send calls**
`apps/api/src/lib/collab/collabDocument.ts`

Line 273 uses `new Buffer(responseMessage)`, while lines 322 and 341 use `Buffer.from(message)`. All should use
`Buffer.from()`.

**10. Excessive console.log in production paths**
`apps/api/src/lib/collab/collabDocument.ts`, lines 153, 163, 210, 225, 236, 344

Every document creation, init, subscribe, unsubscribe, and sync step produces console output. For a system with many
concurrent users and documents, this generates significant log noise. Consider using a debug-level logger or removing
the verbose logs.

**11. `revisionId` param not validated as integer**
`apps/api/src/routes/collab.ts`, line 46

```typescript
const state = document.getRevisionState(parseInt(params.revisionId, 10));
```

`params.revisionId` is a raw string from the URL. `parseInt` with a non-numeric string returns `NaN`, which passes to
the DB query and returns no result (handled by the 404 check). However, using Elysia's `t.Numeric()` or validating
would be cleaner.

**12. `@ts-ignore` comments suppress type safety**
`apps/api/src/routes/collab.ts`, lines 68, 103, 139

Three `@ts-ignore` comments are used for `ws.data?.user`. This suggests a typing issue with Elysia's WebSocket data
types that should be resolved with proper generics rather than suppressed.

**13. Modifying Set during iteration in `destruct`**
`apps/api/src/lib/collab/collabDocument.ts`, lines 195-198

```typescript
for (const conn of this.connections) {
    conn.close();
    this.connections.delete(conn);
}
```

Deleting from a Set while iterating it. While this works in JavaScript (the spec allows it), it's fragile and may
confuse readers. Consider clearing the set after the loop instead.

**14. WebSocket `close` handler calls `ws.close()` for auth failure**
`apps/api/src/routes/collab.ts`, line 142

Inside the `close` handler, if user is null, `ws.close(1008, ...)` is called. But the WebSocket is already closing
(that's why the `close` handler fired). Calling close on an already-closing socket is a no-op at best, confusing at
worst.

## Robustness

| Area | Assessment |
|------|------------|
| WebSocket cleanup on disconnect | Partial -- works but has double-unsubscribe risk and interval leak |
| Yjs state persistence | Good -- incremental updates + periodic snapshots with revision history |
| Yjs state recovery on restart | Good -- loads latest snapshot + subsequent updates |
| Permission enforcement | Good at connection time; expensive per-message; write-block is correct for sync protocol |
| Concurrent editing | **Broken** -- updates not broadcast between peers |
| Memory management | Good -- documents auto-close when last connection leaves, singleton prevents duplicates |
| Error recovery | Weak -- singleton errors are permanent, DB errors in snapshot only logged |
| Document deletion | Good -- recursive close of collab documents before deletion |

### Write-permission enforcement detail

The read-only check in `handleMessage` (line 253-255) blocks sync message types 1 (SyncStep2) and 2 (Update) for
read-only users, which correctly prevents write operations. SyncStep1 (type 0) is allowed for read-only users, which
is correct since it only requests state.

## Test Coverage

File: `apps/api/src/test/collab.test.ts` (418 lines)

| Category | Tests | Quality |
|----------|-------|---------|
| Auth enforcement | 2 | Good -- unauthenticated and unauthorized access |
| Info endpoint | 3 | Good -- owner, denied, shared read |
| WebSocket connection | 4 | Adequate -- auth, connection, ping-pong, permission |
| Document updates | 4 | Weak -- many tests bail early with `if (wsRes.status !== 101) return` |
| Permission changes | 2 | Weak -- same early-return pattern |

**Coverage gaps**:
- No test for multi-user document sync (broadcast verification) -- this would have caught Critical Issue #1
- No test for revision creation/retrieval via the REST API after actual Yjs operations
- No test for document cleanup after last user disconnects
- No test for concurrent snapshot creation race condition
- WebSocket tests are conditional (`if status !== 101 return`) -- if the test environment doesn't support WS upgrade,
  all WebSocket behavioral tests silently pass without executing
- No tests for the editor route at all

## Recommendations

1. **Fix the broadcast bug immediately** -- this is a fundamental correctness issue that makes collaborative editing
   non-functional for multiple users. Add a `doc.on('update', ...)` handler in `CollabDocument` that broadcasts to all
   other connections.

2. **Wrap snapshot creation in a transaction** and use a bounded DELETE to prevent the race condition that can lose
   updates.

3. **Cache document reference and permissions at connection time** -- store the `CollabDocument` instance and
   `canWrite` boolean on the WebSocket data object during `open`, eliminating per-message DB lookups.

4. **Fix the double-unsubscribe** -- either remove the `close` handler's unsubscribe (rely on `keepWebSocketAlive`), or
   have `keepWebSocketAlive` return the interval ID and clear it in the `close` handler. Choose one cleanup path.

5. **Fix `createAsyncSingleton`** to reset `initializationPromise` on error so transient failures don't permanently
   break document access.

6. **Add editor route tests** and make WebSocket tests fail (not skip) when WS upgrade is unavailable.

7. **Replace `@ts-ignore`** with proper Elysia WebSocket typing.

8. **Replace `new Buffer()`** with `Buffer.from()` on line 273.
