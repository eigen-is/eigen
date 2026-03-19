# BE Code Review: Sheets

## Summary

The Sheets backend has no sheets-specific backend code. Sheets persistence is handled entirely through the shared collab
system (`apps/api/src/lib/collab/`) and Drive infrastructure. The collab system provides WebSocket-based Yjs
synchronization, SQLite-backed update/snapshot storage, and REST endpoints for document info and revision history.
Sheets-specific Drive operations (`createSheets`) are correctly implemented in both `Drive` and `SharedDrive`.

This review covers the collab system as it relates to Sheets, plus the collab route layer and the Drive integration
points.

**Files reviewed:**

- `apps/api/src/lib/collab/collabDocument.ts` (Yjs persistence + WebSocket management)
- `apps/api/src/lib/collab/schema.ts` (Drizzle schema)
- `apps/api/src/lib/collab/db-config.ts` (Database config + migrations)
- `apps/api/src/routes/collab.ts` (REST + WebSocket routes)
- `apps/api/src/utils/websockets.ts` (Keep-alive utility)
- `apps/api/src/lib/drive/drive.ts` (`createSheets` method)
- `apps/api/src/lib/drive/sharedDrive.ts` (`createSheets` override)

## Critical Issues

### 1. `canWrite` leaks when `canRead` is false

**File:** `apps/api/src/routes/collab.ts`, lines 17-24

When `canRead` is `false`, the response still includes the real `canWrite` value. This leaks authorization metadata to
unauthorized users.

```typescript
if (!canRead) {
    return {canRead, canWrite, path: null, folderContents: null};
    //              ^^^^^^^^ should be `canWrite: false`
}
```

**Impact:** Information disclosure -- an attacker can probe whether they have write access to a document they cannot
read.

**Fix:** Return `canWrite: false` when `canRead` is `false`.

### 2. Per-message permission check is expensive

**File:** `apps/api/src/routes/collab.ts`, lines 138-139

Every incoming WebSocket message triggers `getSharedDrive()` and `drive.canWrite()`. For sheets with rapid editing
(many ops per second), this creates a new `SharedDrive` instance and runs ACL checks on every single message.

```typescript
const drive = await getSharedDrive(ownerId, user);
const canWrite = await drive.canWrite(mountId, pathId, user);
```

**Impact:** Significant performance overhead on high-frequency editing sessions. Each message does a full ACL
traversal.

**Fix:** Cache the `canWrite` result on `ws.data` during the `open` handler and refresh it periodically (e.g., every
30 seconds) or on reconnect, rather than checking on every message.

### 3. `revisionId` parameter not validated as integer

**File:** `apps/api/src/routes/collab.ts`, line 48

The revision endpoint uses `parseInt(params.revisionId, 10)` but has no Elysia param schema validation. If
`revisionId` is `"abc"`, `parseInt` returns `NaN`, which is passed to `getRevisionState(NaN)`.

```typescript
const state = document.getRevisionState(parseInt(params.revisionId, 10));
```

The HTTP routes for `/collab/:ownerId/:mountId/:pathId/info` and `/collab/:ownerId/:mountId/:pathId/revisions` also
lack Elysia `params` schema validation (unlike the WebSocket route which has `t.Object` validation).

**Impact:** Potential unexpected behavior from NaN comparisons in SQLite queries.

**Fix:** Add `params: t.Object({...revisionId: t.Numeric()})` schema validation to all three HTTP routes.

## Security Concerns

### 4. Twelve `@ts-ignore` annotations suppress type safety

**File:** `apps/api/src/routes/collab.ts`, lines 68, 87-90, 94, 96, 117, 128, 134, 147-150, 153, 155

The WebSocket handler uses `@ts-ignore` extensively to store custom data on `ws.data` (e.g., `collabDocument`,
`collabCleaned`). This bypasses TypeScript's type system at the most security-critical boundary.

**Impact:** If Elysia changes `ws.data` shape or access patterns, bugs will be silent. No compile-time safety for
authentication checks.

**Fix:** Define a proper WebSocket data type that includes `collabDocument`, `collabCleaned`, and `user` fields.
Elysia's WebSocket handler supports typed `ws.data` via a generic parameter.

### 5. Read-only enforcement relies on Yjs protocol internals

**File:** `apps/api/src/lib/collab/collabDocument.ts`, lines 278-282

```typescript
const updateType = decoding.peekUint8(decoder);
if (!canWrite && (updateType === 1 || updateType === 2)) {
    return;
}
```

The write check uses raw Yjs sync protocol message type numbers (1 = SyncStep2, 2 = Update). These magic numbers are
undocumented and could change between `y-protocols` versions.

**Impact:** If `y-protocols` changes its message format, the read-only enforcement silently breaks, allowing
unauthorized writes.

**Fix:** Import and use named constants from `y-protocols/sync` (e.g., `messageYjsSyncStep2`, `messageYjsUpdate`) if
available, or add a comment documenting the protocol version dependency. Consider adding integration tests for
read-only enforcement.

### 6. Deprecated `new Buffer()` constructor

**File:** `apps/api/src/lib/collab/collabDocument.ts`, line 299

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated in Node.js (security concern: uninitialized memory in older versions). The rest of the
file correctly uses `Buffer.from()`.

**Impact:** Low risk in Bun runtime, but inconsistent and flagged by linters.

**Fix:** Replace with `Buffer.from(responseMessage)` for consistency with lines 191, 205, 348, 369, 384.

## Data Integrity

### 7. `createSnapshot` is not wrapped in a transaction

**File:** `apps/api/src/lib/collab/collabDocument.ts`, lines 82-117

The `createSnapshot` method performs four separate database operations:

1. Select last update ID
2. Insert snapshot
3. Delete updates up to that ID
4. Prune old snapshots

These are not wrapped in a SQLite transaction. If the process crashes between step 2 (insert snapshot) and step 3
(delete updates), the next `loadState` call will apply those updates on top of a snapshot that already includes them,
causing duplicate application. While Yjs updates are idempotent (duplicate application is safe), this wastes space
and processing time.

If a crash occurs between step 3 and step 4, old snapshots accumulate beyond `MAX_REVISIONS`.

**Impact:** Low -- Yjs handles duplicate updates gracefully. But wrapping in a transaction is a correctness
improvement with no downside.

**Fix:** Wrap the four operations in `db.transaction(tx => { ... })`.

### 8. `storeUpdate` silently swallows errors

**File:** `apps/api/src/lib/collab/collabDocument.ts`, lines 67-79

```typescript
private
storeUpdate(update
:
Uint8Array
):
void {
    try {
        this.db.insert(schema.docUpdates).values({...}).run();
        this.updatesSinceSnapshot++;
        if(this.updatesSinceSnapshot >= SNAPSHOT_INTERVAL
)
{
    this.createSnapshot();
}
} catch
(error)
{
    console.error(`[DbProvider] Error storing update for ${this.docId}:`, error);
}
}
```

If the insert fails (e.g., disk full), the update is lost. The Yjs document in memory has the update applied, but it
will never be persisted. The next snapshot might capture it, but if the server restarts before a snapshot, the update
is permanently lost.

**Impact:** Potential data loss under disk pressure or database corruption.

**Fix:** Consider retrying the insert, or at minimum incrementing a failure counter and forcing a snapshot sooner to
capture the in-memory state.

## Code Quality

### 9. `keepWebSocketAlive` interval never cleared on normal close

**File:** `apps/api/src/utils/websockets.ts`, lines 4-20

The `keepWebSocketAlive` function creates a `setInterval` but only clears it when the ping fails or the socket is
not open. When the WebSocket closes normally (via the `close` handler in `collab.ts`), the interval continues running
until the next tick detects `readyState > 1`.

**Impact:** Minor resource leak -- the interval ticks once more after the connection is already cleaned up.

**Fix:** Return the interval ID from `keepWebSocketAlive` and clear it in the `close` handler. Or store it on
`ws.data` for cleanup.

### 10. `CollabDocument` uses `export default`

**File:** `apps/api/src/lib/collab/collabDocument.ts`, line 141

```typescript
export default class CollabDocument {
```

The project convention (per CONTRIBUTING.md) prefers named exports.

**Fix:** Change to `export class CollabDocument` and update imports.

## Architecture

### 11. SharedDrive properly overrides `createSheets`

**Files:** `apps/api/src/lib/drive/drive.ts`, line 189 and `apps/api/src/lib/drive/sharedDrive.ts`, line 157

The `SharedDrive.createSheets()` override correctly delegates to the underlying drive after checking write
permissions. This follows the documented pattern for ensuring new eigen file types work on shared/team drives.

### 12. Schema is minimal and correct

**File:** `apps/api/src/lib/collab/schema.ts`

The collab schema defines `doc_updates` (incremental Yjs updates) and `doc_snapshots` (compacted state) with proper
typing (`blob` with `mode: 'buffer'`). The `createdAt` timestamps use `unixepoch()` for consistency.

## Positive Patterns

- **Proper access control on all routes**: Every HTTP and WebSocket endpoint checks `canRead`/`canWrite` via
  `getSharedDrive()` and the ACL system
- **Clean Yjs lifecycle management**: `DbProvider` correctly hooks into `doc.on('update')` and cleans up in
  `destroy()`
- **Awareness protocol support**: Client presence information is properly tracked per-connection and cleaned up on
  disconnect
- **Stale connection cleanup**: `unsubscribe` proactively scans for stale connections (readyState > 1)
- **Snapshot compaction**: The `SNAPSHOT_INTERVAL` / `MAX_REVISIONS` pattern prevents unbounded database growth
- **Revision history support**: Clean `getRevisions()` / `getRevisionState()` API for the frontend revision viewer

## Recommendations

| Priority | Issue | Description                                                    |
|----------|-------|----------------------------------------------------------------|
| **P0**   | #1    | Fix `canWrite` leak when `canRead` is false                    |
| **P0**   | #5    | Document or use named constants for Yjs protocol message types |
| **P1**   | #2    | Cache `canWrite` per-connection instead of per-message         |
| **P1**   | #3    | Add Elysia param schema validation to HTTP routes              |
| **P1**   | #7    | Wrap `createSnapshot` in a transaction                         |
| **P1**   | #4    | Replace `@ts-ignore` with proper WebSocket data types          |
| **P2**   | #6    | Replace `new Buffer()` with `Buffer.from()`                    |
| **P2**   | #8    | Add resilience to `storeUpdate` failure path                   |
| **P2**   | #9    | Return and clear interval from `keepWebSocketAlive`            |
| **P2**   | #10   | Use named export for `CollabDocument`                          |
