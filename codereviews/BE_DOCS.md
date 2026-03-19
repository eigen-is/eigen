# BE Code Review: Docs (Collaborative Editing / Collab)

## Summary

The Docs backend comprises the Yjs collaboration layer (`apps/api/src/lib/collab/`), the collab WebSocket/HTTP routes
(`apps/api/src/routes/collab.ts`), and the inline editor routes (`apps/api/src/routes/editor.ts`). The core
`CollabDocument` class is well-structured with snapshot compaction, awareness tracking, and a clean DbProvider
abstraction. However, the WebSocket route relies heavily on `@ts-ignore` (12 occurrences) instead of proper typing, the
read-only enforcement in `handleMessage` can be bypassed via awareness messages, and there are several robustness gaps
around resource cleanup and race conditions.

## Critical Issues

### 1. `keepWebSocketAlive` never clears its interval on normal close

- **File**: `apps/api/src/utils/websockets.ts`, lines 5-19
- **Issue**: `keepWebSocketAlive` starts a `setInterval` that pings every 15 seconds. It clears the interval when ping
  fails or the socket is not open, but there is no mechanism to clear it when the WebSocket closes normally (via the
  `close` handler in `collab.ts`). The `onClose` callback is only invoked when ping fails -- it is not the same as the
  WebSocket `close` event. This means the interval keeps running and attempting pings on a destroyed socket until one
  finally fails and triggers cleanup.
- **Why it matters**: Resource leak. Each open+close cycle leaves a dangling interval for up to 15 seconds. Under load
  with many short-lived connections, this accumulates.
- **Suggested fix**: Return the interval ID from `keepWebSocketAlive` so the caller can clear it in the `close` handler,
  or accept a signal/AbortController for cancellation.

### 2. Snapshot compaction deletes updates that may be needed by concurrent readers

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 82-117 (`createSnapshot`)
- **Issue**: `createSnapshot()` inserts a snapshot then immediately deletes all updates up to `lastUpdateId` (line
  98-100). If another connection is concurrently reading updates (via `loadState` on a new `DbProvider` or
  `getRevisionState`), the delete could remove rows that were referenced between the snapshot query and the updates
  query, causing a gap. SQLite WAL mode provides snapshot isolation for a single transaction, but `loadState` uses two
  separate queries (snapshot + updates) without a transaction wrapper.
- **Why it matters**: On a busy document with many concurrent editors, a new joiner could miss updates between the
  snapshot and the deleted updates, resulting in a diverged document state.
- **Suggested fix**: Wrap the snapshot read + updates read in `loadState()` inside a single Drizzle transaction, or
  retain updates for a grace period after snapshot creation (e.g., keep updates from the last 2 snapshots).

### 3. Per-message `canWrite` check is expensive and races with ACL changes

- **File**: `apps/api/src/routes/collab.ts`, lines 126-140 (message handler)
- **Issue**: Every incoming WebSocket message triggers `getSharedDrive(ownerId, user)` and `drive.canWrite(mountId,
  pathId, user)`. This involves at least two async operations per keystroke per user. Additionally, the `canWrite`
  result
  could change between the check and the actual `handleMessage` call, creating a TOCTOU race.
- **Why it matters**: Performance bottleneck under heavy editing load. The permission check likely hits the database on
  every keystroke.
- **Suggested fix**: Cache the `canWrite` result on `ws.data` at connection open time (it's already fetched there via
  the
  `/info` endpoint pattern). Refresh it periodically (e.g., every 30 seconds) or on ACL change events rather than on
  every message. Store `drive` on `ws.data` as well to avoid re-fetching it.

### 4. Read-only bypass: sync step 1 response (step 2) is blocked but awareness is always allowed

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 277-282
- **Issue**: The read-only check `if (!canWrite && (updateType === 1 || updateType === 2))` blocks sync updates and sync
  step 2, but awareness messages (MESSAGE_AWARENESS = 1) are always processed and broadcast. A read-only user can
  therefore send arbitrary awareness state, which is broadcast to all clients. While awareness is typically used for
  cursor positions, a malicious client could send large awareness payloads to other clients.
- **Why it matters**: A read-only user can influence other clients' rendering via awareness spam.
- **Suggested fix**: Rate-limit or size-limit awareness updates from read-only users, or consider whether read-only
  users
  should have their awareness broadcast at all.

## Pattern Violations

### 12 `@ts-ignore` directives in collab.ts

- **File**: `apps/api/src/routes/collab.ts`, lines 68, 87, 89, 93, 95, 117, 128, 134, 147, 149, 152, 154
- **Issue**: The WebSocket handler stores `collabDocument` and `collabCleaned` on `ws.data` via `@ts-ignore` instead of
  properly typing the WebSocket data. CLAUDE.md forbids `as any` and by extension `@ts-ignore` for type suppression.
- **Why it matters**: Silently breaks type safety. Any typo in property names (e.g., `collabDocuement`) would not be
  caught. This is the single largest type safety gap in the Docs backend.
- **Suggested fix**: Define a proper WebSocket data type:
  ```typescript
  type CollabWsData = {
      user: User;
      params: { ownerId: string; mountId: string; pathId: string };
      collabDocument?: CollabDocument;
      collabCleaned?: boolean;
  };
  ```
  Then use `ws as ServerWebSocket<CollabWsData>` or type the Elysia WebSocket generics properly.

### `as Uint8Array` casts on Drizzle blob fields

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 49, 55, 61, 132
- **Issue**: The schema declares `blob('updateData', {mode: 'buffer'})` which returns `Buffer`, but the code casts to
  `Uint8Array`. While `Buffer extends Uint8Array` in Node/Bun, this cast is unnecessary and masks potential type issues.
- **Why it matters**: CLAUDE.md says to fix the type at the source rather than casting. The schema already declares
  buffer mode, so the field is already `Buffer` which is assignable to `Uint8Array`.
- **Suggested fix**: Remove the `as Uint8Array` casts since `Buffer` is already a `Uint8Array` subclass. If Yjs requires
  exactly `Uint8Array`, use `new Uint8Array(snapshot.stateData)` for an explicit conversion.

### `interface` used where `type` is required

- **File**: `apps/api/src/routes/collab.ts` -- not directly, but the route's data shape is untyped entirely
- **Note**: The backend files themselves avoid `interface`, which is correct.

## Security Concerns

### 1. No size limit on WebSocket messages

- **File**: `apps/api/src/routes/collab.ts`, line 111 (message handler)
- **Issue**: The WebSocket message handler processes any `Uint8Array` message without checking its size. A malicious
  client could send very large Yjs updates that consume memory when applied to the document and stored in the database.
- **Why it matters**: Denial of service. A single client could send a multi-megabyte update that gets stored in SQLite
  and broadcast to all other clients.
- **Suggested fix**: Add a maximum message size check at the top of the message handler. Elysia/Bun WebSocket config
  supports `maxPayloadLength` -- set it to a reasonable limit (e.g., 1MB).

### 2. No validation that `revisionId` is a positive integer

- **File**: `apps/api/src/routes/collab.ts`, line 48
- **Issue**: `parseInt(params.revisionId, 10)` is used without Elysia schema validation. A non-numeric `revisionId`
  would result in `NaN`, which when passed to the SQLite query would return no results (benign) but is still unvalidated
  input.
- **Why it matters**: Defense in depth. The route should use `t.Numeric()` or `t.Number()` in the params schema.
- **Suggested fix**: Add params validation: `params: t.Object({ ..., revisionId: t.String() })` and validate it's
  numeric, or use Elysia's `t.Numeric()` transform.

### 3. `closeCollabDocument` uses `withReadPermission` instead of `withWritePermission`

- **File**: `apps/api/src/lib/drive/sharedDrive.ts`, lines 110-112
- **Issue**: `closeCollabDocument` is gated by read permission. However, closing a collab document triggers
  `destruct()` which forces a snapshot and disconnects all current editors. A user with only read access should not be
  able to force-close a document that other users are editing.
- **Why it matters**: A read-only user could disrupt active editing sessions.
- **Suggested fix**: This method should require write permission, or better yet, should only be callable internally (not
  exposed via SharedDrive at all) since it's used during deletion which already requires write permission.

### 4. No authentication token validation on WebSocket upgrade

- **File**: `apps/api/src/routes/collab.ts`, lines 67-69
- **Issue**: The `open` handler checks `ws.data?.user` but relies on `@ts-ignore` to access it. If the auth middleware
  fails silently or is bypassed during the WebSocket upgrade handshake, `user` could be undefined and the close with
  1008 fires, but between the upgrade and the open handler, there's a window where the connection exists without
  verified auth.
- **Why it matters**: WebSocket auth is notoriously tricky. The `betterAuth` middleware may not apply to WebSocket
  upgrades the same way it applies to HTTP requests.
- **Suggested fix**: Verify that `betterAuth` properly intercepts WebSocket upgrade requests. Add explicit auth
  verification in the upgrade phase, not just in the `open` handler.

## Data Integrity

### 1. No transaction around snapshot creation + update deletion

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 82-117
- **Issue**: `createSnapshot()` performs three separate database operations (insert snapshot, delete updates,
  query+delete
  old snapshots) without wrapping them in a transaction. If the process crashes after inserting the snapshot but before
  deleting updates, the next `loadState()` would apply the snapshot AND the updates that the snapshot already includes,
  resulting in duplicate application of Yjs updates (which Yjs handles idempotently, so no data loss, but wasted work).
  More concerning: if the delete succeeds but old snapshot cleanup fails, data accumulates.
- **Why it matters**: While Yjs is idempotent for duplicate updates, the lack of transactional guarantees means the
  database can be left in unexpected states.
- **Suggested fix**: Wrap the entire `createSnapshot()` in a Drizzle transaction.

### 2. `loadState` does not handle corrupted Yjs data

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 42-64
- **Issue**: `Y.applyUpdate()` can throw if the stored binary data is corrupted. `loadState()` has no try/catch, so a
  corrupted snapshot or update would crash the entire document initialization and prevent any user from accessing the
  document.
- **Why it matters**: A single corrupted row makes the document permanently inaccessible until manual database
  intervention.
- **Suggested fix**: Wrap `Y.applyUpdate` calls in try/catch. On corruption, skip the corrupted entry and log an error.
  Consider storing a checksum alongside updates for validation.

### 3. Document auto-close race condition

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 263-266 (in `unsubscribe`)
- **Issue**: When the last connection disconnects (`this.connections.size <= 0`), the document calls
  `this.drive.closeCollabDocument()`. However, between checking the size and calling close, a new connection could
  arrive via `subscribe()`. The `closed` flag is set in `destruct()` which would reject the new subscriber, but the
  subscriber might have already passed the `if (this.closed)` check in `subscribe` before `destruct` sets the flag.
- **Why it matters**: Race condition could leave a client connected to a destroyed document with no data persistence.
- **Suggested fix**: Add a mutex or use `closed` flag atomically. Alternatively, delay the auto-close by a few seconds
  to handle rapid disconnect/reconnect cycles.

## Code Quality

### 1. Unused `_user` parameter in `subscribe` and `unsubscribe`

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, lines 233, 241
- **Issue**: Both methods accept `_user: User` but never use it (prefixed with underscore). However, the caller always
  passes the user, suggesting it was intended for access control or awareness tracking.
- **Why it matters**: Unused parameters add noise. If user tracking per connection is desired (e.g., for audit logs or
  per-user awareness cleanup), it should be implemented; otherwise remove the parameter.
- **Suggested fix**: Either use the user parameter (e.g., store user info per connection for debugging) or remove it.

### 2. `new Buffer()` is deprecated

- **File**: `apps/api/src/routes/collab.ts`, line 299; `apps/api/src/lib/collab/collabDocument.ts`, line 299 equivalent
- **Issue**: `new Buffer(responseMessage)` uses the deprecated `Buffer` constructor. Should use `Buffer.from()`.
- **Why it matters**: `new Buffer()` is deprecated in Node.js and may be removed in future Bun versions.
- **Suggested fix**: Replace `new Buffer(responseMessage)` with `Buffer.from(responseMessage)`.

### 3. Inconsistent error response patterns

- **File**: `apps/api/src/routes/collab.ts`
- **Issue**: The `/revisions/:revisionId` route uses `set.status = 403/404` with `{error: "..."}` objects, while the
  `/info` route returns `{canRead: false, ...}` instead of an error. The `/revisions` route silently returns empty
  arrays on permission failure instead of 403.
- **Why it matters**: Inconsistent error handling makes client-side error handling unreliable.
- **Suggested fix**: Use `ApiError` consistently (throw `new ApiError(403, "...")`) across all collab routes.

### 4. `docId` stored but never used in DbProvider

- **File**: `apps/api/src/lib/collab/collabDocument.ts`, line 25
- **Issue**: `DbProvider` stores `this.docId` but only uses it in error log messages. The field name is also misleading
  since it receives `this.path.name` (a filename, not an ID).
- **Why it matters**: Minor naming confusion and unnecessary storage.
- **Suggested fix**: Rename to `docName` for clarity, or pass it only to the error logging calls.

## Architecture

### Yjs document lifecycle is well-designed

The `CollabDocument` -> `DbProvider` -> `ManagedDatabase` layering is clean. The snapshot compaction strategy
(every 100 updates, keep last 50 revisions) is reasonable for a document editor. The separation of concerns between
the Yjs document management (`CollabDocument`), persistence (`DbProvider`), and transport (WebSocket route) is good.

### The `documents` map in Drive uses `createAsyncSingleton` correctly

- **File**: `apps/api/src/lib/drive/drive.ts`, lines 542-556
- The singleton pattern ensures only one `CollabDocument` exists per document, which is essential for Yjs to work
  correctly (single source of truth for the document state).

### WebSocket message handling is solid

The message handler correctly distinguishes between sync and awareness messages, uses the Yjs protocol library properly,
and avoids common pitfalls like echo-back (messages are broadcast to all clients except the sender).

## Positive Patterns

1. **Snapshot compaction with configurable thresholds**: `SNAPSHOT_INTERVAL = 100` and `MAX_REVISIONS = 50` are
   well-chosen defaults that balance storage efficiency with revision history depth.
2. **Awareness state cleanup on disconnect**: `unsubscribe` properly removes awareness states for disconnecting clients
   and also cleans up stale connections, preventing ghost cursors.
3. **Read-only enforcement at the protocol level**: The `handleMessage` method checks `canWrite` and silently drops
   write operations from read-only users, rather than disconnecting them.
4. **`perMessageDeflate: true`**: WebSocket compression is enabled, reducing bandwidth for Yjs binary updates.
5. **Revision history API**: The ability to fetch and restore revisions is a valuable feature for document recovery.

## Recommendations

### P0 (Fix immediately)

- Add proper WebSocket data typing to eliminate all `@ts-ignore` in `collab.ts`
- Wrap `loadState()` reads in a transaction to prevent snapshot/update gaps
- Add try/catch around `Y.applyUpdate` in `loadState()` for corruption resilience
- Set `maxPayloadLength` on the WebSocket config to prevent DoS via large messages

### P1 (Fix soon)

- Return interval ID from `keepWebSocketAlive` and clear it in close handler
- Cache `canWrite` on `ws.data` instead of checking per message
- Wrap `createSnapshot()` in a database transaction
- Replace `new Buffer()` with `Buffer.from()`
- Use `ApiError` consistently in collab routes instead of `set.status`
- Add Elysia params validation for `revisionId`

### P2 (Improve when touching)

- Remove unused `_user` parameters or use them for audit logging
- Rename `docId` to `docName` in `DbProvider`
- Add a brief delay before auto-closing a document on last disconnect
- Consider rate-limiting awareness updates from read-only users
- Remove `as Uint8Array` casts that are unnecessary given Buffer extends Uint8Array
- Change `closeCollabDocument` in SharedDrive to require write permission
