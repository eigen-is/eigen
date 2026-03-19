# BE Code Review: Slides

## Summary

The Slides backend has no slides-specific backend code. Slides persistence is handled entirely through the shared
collab system (`apps/api/src/lib/collab/`) and Drive infrastructure. The collab system provides WebSocket-based Yjs
synchronization, SQLite-backed update/snapshot storage, and REST endpoints for document info and revision history. This
review covers the collab system as it relates to Slides, plus the collab route layer.

**Files reviewed:**

- `/apps/api/src/lib/collab/collabDocument.ts` (Yjs persistence + WebSocket management)
- `/apps/api/src/lib/collab/schema.ts` (Drizzle schema)
- `/apps/api/src/lib/collab/db-config.ts` (Database config + migrations)
- `/apps/api/src/routes/collab.ts` (REST + WebSocket routes)
- `/apps/api/src/utils/websockets.ts` (Keep-alive utility)

## Critical Issues

### 1. `canWrite` leaks when `canRead` is false

**File:** `/apps/api/src/routes/collab.ts`, lines 17-30

When `canRead` is `false`, the response still includes `canWrite` (which could be `true` or `false`). This leaks
authorization metadata to unauthorized users. If `canRead` is false, `canWrite` should always be returned as `false`.

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

**File:** `/apps/api/src/routes/collab.ts`, lines 137-139

Every WebSocket message triggers `getSharedDrive()` and `drive.canWrite()`. These involve database lookups on every
keystroke from every collaborator. For a busy document this is a significant performance bottleneck.

```typescript
const drive = await getSharedDrive(ownerId, user);
const canWrite = await drive.canWrite(mountId, pathId, user);
```

**Impact:** High latency under load; unnecessary DB queries on every Yjs update.

**Fix:** Cache the `canWrite` result on `ws.data` during the `open` handler. Re-check periodically (e.g., every 60s)
or on a dedicated "reauth" message, not on every single message.

### 3. Deprecated `new Buffer()` constructor

**File:** `/apps/api/src/lib/collab/collabDocument.ts`, line 299

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated and unsafe (it does not zero-fill memory, risking information leakage from previously
freed memory). All other locations in the same file correctly use `Buffer.from()`.

**Impact:** Potential memory-content leakage in edge cases; deprecation warnings.

**Fix:** Replace with `Buffer.from(responseMessage)`.

## Pattern Violations

### 4. Extensive `@ts-ignore` usage in collab route

**File:** `/apps/api/src/routes/collab.ts`, lines 68, 87-96, 117, 128-134, 147-155

There are 12 `@ts-ignore` comments. The WebSocket handler stores arbitrary data on `ws.data` without type safety:

```typescript
// @ts-ignore
ws.data.collabDocument = document;
// @ts-ignore
ws.data.collabCleaned = false;
```

**Impact:** Type safety is completely bypassed; refactoring will silently break these handlers.

**Fix:** Define a proper WebSocket data type and use it instead of `@ts-ignore`:

```typescript
type CollabWsData = {
    user: User;
    params: { ownerId: string; mountId: string; pathId: string };
    collabDocument?: CollabDocument;
    collabCleaned?: boolean;
};
```

### 5. Revision ID parsed without validation

**File:** `/apps/api/src/routes/collab.ts`, line 48

```typescript
const state = document.getRevisionState(parseInt(params.revisionId, 10));
```

No Elysia schema validation for `revisionId` being a numeric string. `parseInt("abc", 10)` returns `NaN`, which will
be passed to the database query. While SQLite handles this gracefully (no match), it should be validated at the route
level.

**Fix:** Add `params` schema validation:

```typescript
{
    params: t.Object({..., revisionId: t.Numeric()})
}
```

## Security Concerns

### 6. No rate limiting on WebSocket connections or messages

**File:** `/apps/api/src/routes/collab.ts`

There is no rate limiting on WebSocket connection attempts or message throughput. A malicious client could flood the
server with connection requests or Yjs updates.

**Impact:** Potential DoS vector.

**Fix:** Add per-user connection limits and message rate limiting.

### 7. WebSocket authentication relies on initial check only

**File:** `/apps/api/src/routes/collab.ts`, lines 67-109

Authentication is checked during `open`, but session expiry during a long-lived WebSocket connection is never
re-validated. A user whose session is revoked can continue editing indefinitely.

**Impact:** Stale sessions can persist.

**Fix:** Periodically re-validate the session token (e.g., every 5 minutes).

## Data Integrity

### 8. Snapshot creation deletes updates non-atomically

**File:** `/apps/api/src/lib/collab/collabDocument.ts`, lines 82-117

`createSnapshot()` performs three separate database operations (insert snapshot, delete updates, prune old snapshots)
without wrapping them in a transaction. If the process crashes between the snapshot insert and the update deletion,
updates could be double-applied on next load.

```typescript
this.db.insert(schema.docSnapshots).values({...}).run();
this.db.delete(schema.docUpdates).where(...).run();
this.db.delete(schema.docSnapshots).where(...).run();
```

**Impact:** Potential data corruption after crash -- duplicate Yjs updates applied to state.

**Fix:** Wrap all three operations in a single transaction:

```typescript
this.db.transaction((tx) => {
    tx.insert(schema.docSnapshots).values({...}).run();
    tx.delete(schema.docUpdates).where(...).run();
    // prune old snapshots
});
```

### 9. No index on `doc_updates.id` or `doc_snapshots.id` (beyond PRIMARY KEY)

**File:** `/apps/api/src/lib/collab/db-config.ts`

The queries use `orderBy(desc(id))` and `where(gt(id, ...))` / `where(lte(id, ...))`. These are covered by the PRIMARY
KEY index, so this is fine. However, there is no `createdAt` index, meaning revision listing by date would require a
full scan. Minor concern for now since revision queries use `id` ordering.

## Code Quality

### 10. `DbProvider` error handling swallows context

**File:** `/apps/api/src/lib/collab/collabDocument.ts`, lines 67-79, 82-117

Errors in `storeUpdate()` and `createSnapshot()` are logged but never propagated or tracked. If the database is full or
corrupted, updates silently fail and the in-memory Yjs doc diverges from persistence.

**Impact:** Silent data loss -- users see their changes in real-time but they are not persisted.

**Fix:** At minimum, track consecutive failures and emit a health event. Consider closing the document if persistence
fails repeatedly.

### 11. Connection cleanup in `unsubscribe` iterates all connections

**File:** `/apps/api/src/lib/collab/collabDocument.ts`, lines 252-262

On every unsubscribe, the code iterates all remaining connections to clean up stale ones. This is O(n) on every
disconnect and would be better handled by a periodic sweep or by checking state only on send failure.

### 12. `keepWebSocketAlive` interval is never explicitly cleared on normal close

**File:** `/apps/api/src/utils/websockets.ts`

The ping interval is only cleared when `readyState` changes or ping fails. When the WebSocket closes normally, the
interval keeps running until the next tick detects the state change. While not a leak (it clears within 15 seconds),
it would be cleaner to return the interval ID so the caller can clear it in the `close` handler.

## Architecture

### 13. Collab system is shared infrastructure, not slides-specific

The slides app has zero backend-specific code. All Yjs sync, persistence, and access control is handled by the generic
collab system. This is a good design -- adding new Yjs-based apps requires no backend changes. The Yjs data model
(slides, objects, slideOrder) is entirely client-side and transparent to the backend.

### 14. No server-side validation of Yjs document structure

The backend stores raw Yjs updates without any awareness of the slides data model. A malicious or buggy client could
write arbitrary data into the Yjs document (e.g., invalid coordinates, missing required fields, XSS payloads in text
fields). This is a conscious tradeoff for simplicity and real-time performance, but worth noting.

## Positive Patterns

- **Clean separation of concerns:** `DbProvider` handles persistence, `CollabDocument` handles WebSocket management.
  The route layer is thin
- **Snapshot + incremental updates:** The compaction strategy (snapshot every 100 updates, prune to 50 revisions) is a
  solid approach for Yjs persistence
- **Read-only enforcement:** The `canWrite` check in `handleMessage` correctly blocks sync updates (type 1 and 2) for
  read-only users while still allowing sync step 0 (state request)
- **Awareness cleanup:** Client awareness states are properly tracked per-connection and removed on disconnect
- **Cross-owner access:** The collab routes correctly use `getSharedDrive()` to support collaborative editing across
  owner boundaries

## Recommendations

| Priority | Issue | Description                                                       |
|----------|-------|-------------------------------------------------------------------|
| **P0**   | #1    | Fix `canWrite` leak when `canRead` is false                       |
| **P0**   | #3    | Replace deprecated `new Buffer()` with `Buffer.from()`            |
| **P0**   | #8    | Wrap snapshot creation in a database transaction                  |
| **P1**   | #2    | Cache `canWrite` per-connection instead of checking every message |
| **P1**   | #4    | Replace `@ts-ignore` with proper WebSocket data types             |
| **P1**   | #10   | Add failure tracking for persistence errors                       |
| **P2**   | #5    | Add Elysia param validation for `revisionId`                      |
| **P2**   | #6    | Add rate limiting on WebSocket connections                        |
| **P2**   | #7    | Add periodic session re-validation                                |
| **P2**   | #12   | Return interval ID from `keepWebSocketAlive` for explicit cleanup |
