# BE Code Review: Stickies (Collab System)

## Summary

The Stickies backend is entirely handled by the shared **collab** subsystem (`apps/api/src/lib/collab/` and
`apps/api/src/routes/collab.ts`). There is no stickies-specific backend code. The collab system provides Yjs document
persistence via SQLite, WebSocket-based real-time sync, revision history, and access-control enforcement through
`getSharedDrive()`. The architecture is sound overall, but the WebSocket route has excessive `@ts-ignore` usage, a
potential race condition in the message handler, and missing input validation on path parameters.

## Critical Issues

### 1. Race condition: message before open completes

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/collab.ts`, lines 128-136

When a WebSocket message arrives before the `open` handler finishes (the `open` handler is `async`), the `message`
handler re-fetches the document and stores it on `ws.data.collabDocument`. However, this means:

- The `subscribe()` call from `open` may not have run yet, so the connection is not tracked.
- Two concurrent `getCollabDocument()` calls could race.
- The `keepWebSocketAlive` cleanup won't fire because it was set up with the `open` handler's document reference.

**Impact**: Possible missed messages, orphaned connections, or double-subscribe if `open` completes after the fallback
in `message`.

**Fix**: Either guarantee `open` completes before `message` fires (Bun guarantees this for WS), or add a
`Promise`-based initialization gate that `message` awaits.

### 2. Permission check per message is expensive but incomplete

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/collab.ts`, lines 138-139

Every incoming WebSocket message calls `getSharedDrive()` and `drive.canWrite()`. While this ensures up-to-date
permissions, it:

- Hits the database/ACL system on every keystroke from every user.
- Only gates write-type sync messages (updateType 1 or 2), but still allows read-only users to send awareness updates
  that are broadcast to all clients.

**Impact**: Performance bottleneck under high edit throughput; awareness messages from revoked users still broadcast.

**Fix**: Cache the `canWrite` result at connection time (checked in `open`) and re-check periodically (e.g., every 30s)
rather than per message. For awareness, consider whether revoked users should be disconnected entirely.

## Pattern Violations

### 3. Excessive `@ts-ignore` in WebSocket route

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/collab.ts`, lines 68, 87, 89, 93, 95, 117, 128,
134, 147, 149, 152, 154 (12 occurrences)

The WebSocket handlers use `@ts-ignore` extensively to access `ws.data.user`, `ws.data.collabDocument`, and
`ws.data.collabCleaned`. This bypasses TypeScript's type safety entirely.

**Fix**: Define a proper WebSocket data type and use it with the `ws()` handler:

```typescript
type CollabWsData = {
    user: User;
    params: { ownerId: string; mountId: string; pathId: string };
    collabDocument?: CollabDocument;
    collabCleaned?: boolean;
};
```

### 4. `new Buffer()` usage (deprecated)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/collab/collabDocument.ts`, line 299

```typescript
conn.send(new Buffer(responseMessage));
```

`new Buffer()` is deprecated. Should use `Buffer.from()` (which is already used elsewhere in the same file, e.g., lines
191, 369).

## Security Concerns

### 5. No input validation on path parameters

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/collab.ts`, lines 17, 32, 41

The HTTP routes (`/collab/:ownerId/:mountId/:pathId/...`) accept raw string parameters without validation. While
`getSharedDrive()` and `drive.canRead()` enforce access control, the `revisionId` parameter at line 48 is parsed with
`parseInt()` without range validation -- a non-numeric string returns `NaN`.

**Fix**: Add Elysia `t.Numeric()` validation for `revisionId`, and consider adding format validation for `ownerId`,
`mountId`, `pathId` (UUID or prefixed-ID patterns).

### 6. WebSocket authentication relies on `ws.data.user` which may be undefined

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/collab.ts`, lines 68-69

The `open` handler checks `ws.data?.user` but the `{auth: true}` config on the WS route should guarantee a user. The
defensive check is good, but the `@ts-ignore` makes it impossible to verify this statically.

## Data Integrity

### 7. Snapshot creation deletes updates non-atomically

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/collab/collabDocument.ts`, lines 82-117

The `createSnapshot()` method:

1. Encodes the full document state
2. Gets the last update ID
3. Inserts the snapshot
4. Deletes all updates up to that ID
5. Prunes old snapshots

Steps 3-5 are not wrapped in a transaction. If the process crashes between step 3 and step 4, the updates remain and
will be re-applied on next load (resulting in duplicate data in the Yjs doc, though Yjs is idempotent so this is safe).
If it crashes between step 4 and step 5, old snapshots accumulate (minor).

**Impact**: Low -- Yjs handles duplicate updates gracefully. But wrapping in a transaction would be cleaner.

### 8. `storeUpdate` silently swallows errors

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/collab/collabDocument.ts`, lines 67-79

If `storeUpdate` fails (e.g., disk full), the error is logged but the update is lost. The Yjs document in memory has the
update, but it won't survive a restart. Other clients who received the broadcast will have the data, but the server's
persistent state is inconsistent.

**Impact**: Potential data loss on disk errors. Consider at minimum incrementing an error counter and warning the user.

## Code Quality

### 9. `CollabDocument` constructor does not call `init()`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/collab/collabDocument.ts`, lines 152-156, 164-211

The constructor creates a partially initialized object (`doc!`, `provider!`, `awareness!` use definite assignment
assertions). The caller must call `init()` separately. This two-step initialization pattern is error-prone.

**Impact**: If `init()` is not called, accessing `doc`, `provider`, or `awareness` will throw at runtime despite passing
type checks.

**Fix**: Use a static factory method pattern: make the constructor private and expose only
`static async create()` that returns a fully initialized instance.

### 10. `ServerWebSocket<any>` used throughout

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/collab/collabDocument.ts`, lines 147-148

The connections set and related maps use `ServerWebSocket<any>`. This loses all type information about the WebSocket
data payload.

## Architecture

### 11. No stickies-specific backend validation

The collab system treats all Yjs documents identically -- docs, stickies, slides, and sheets all share the same
storage and sync mechanism. This is elegant but means there is no server-side validation of the Kanban board data
model. A malicious client could inject arbitrary data into the Yjs document (e.g., corrupted column structures,
missing task references).

**Impact**: The frontend's `normalizeBoard()` handles some inconsistencies, but a dedicated server-side validator
could prevent malformed board state from being persisted.

### 12. `keepWebSocketAlive` interval never cleaned up on normal close

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/utils/websockets.ts`, lines 4-20

The `keepWebSocketAlive` function creates a `setInterval` but only clears it when `ping()` fails or `readyState` is not
OPEN. On a normal `close` event (client disconnects cleanly), the interval continues until the next ping attempt detects
the closed state. The `cleanup` callback fires from the interval, not from the `close` handler.

The `close` handler in `collab.ts` (line 146) calls `unsubscribe` directly, but doesn't clear the ping interval.

**Fix**: Return the interval ID from `keepWebSocketAlive` and clear it in the `close` handler.

## Positive Patterns

- **Snapshot + incremental updates**: The dual-storage approach (periodic snapshots + incremental updates) is
  well-designed for Yjs persistence. The `SNAPSHOT_INTERVAL` of 100 updates is reasonable.
- **Revision history**: Clean implementation of revision tracking via snapshots with pruning (`MAX_REVISIONS = 50`).
- **Access control delegation**: Using `getSharedDrive()` to enforce ACL for both HTTP and WebSocket routes keeps
  authorization logic centralized.
- **Awareness protocol**: Proper tracking of client IDs per connection enables clean awareness state cleanup on
  disconnect.
- **Read-only enforcement**: The `canWrite` check in `handleMessage` (line 280) correctly blocks sync update messages
  (types 1 and 2) for read-only users at the protocol level.

## Recommendations

| Priority | Issue                                   | Action                                           |
|----------|-----------------------------------------|--------------------------------------------------|
| P0       | #1 Race condition in WS message handler | Add initialization gate or verify Bun guarantees |
| P1       | #3 12x `@ts-ignore` in collab route     | Define proper WS data type                       |
| P1       | #5 No input validation on route params  | Add Elysia type validators                       |
| P1       | #8 Silent update storage failures       | Add error propagation or user notification       |
| P1       | #12 Ping interval leak on clean close   | Return and clear interval ID                     |
| P2       | #2 Per-message permission check         | Cache permissions with periodic refresh          |
| P2       | #4 Deprecated `new Buffer()`            | Replace with `Buffer.from()`                     |
| P2       | #7 Non-atomic snapshot creation         | Wrap in SQLite transaction                       |
| P2       | #9 Two-step initialization              | Use static factory method                        |
| P2       | #10 `ServerWebSocket<any>` types        | Define typed WebSocket generic                   |
| P2       | #11 No server-side board validation     | Consider optional schema validation              |
