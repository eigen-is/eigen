# BE Code Review: Chat

## Summary

The chat backend is well-structured with a clean separation between the `ChatRoom` domain class, the route layer, and
the command parser. ACL enforcement is properly delegated to `SharedDrive`, whisper privacy is handled server-side, and
the test suite (`apps/api/src/test/chat.test.ts`) is thorough. However, there are data integrity issues around
pagination, a race condition in `markRead`, security concerns related to attachment deletion and missing validation on
edit, and SSE whisper leakage.

## Critical Issues

### 1. SSE broadcasts whisper existence to all users (privacy leak)

**File**: `apps/api/src/lib/chat/chat.ts`, lines 116-124

When a whisper is posted, the SSE event strips `content` and `whisperTo` but still broadcasts the event with `type:
'whisper'` to **all** connected users (via `home.notify`). Any user subscribed to SSE sees that a whisper was posted and
can observe timing patterns. The `getMessagesForUser` method correctly hides content, but the SSE layer bypasses that.

**Impact**: Information leakage — observers can detect whisper activity between users.

**Fix**: Either suppress SSE for whisper messages entirely, or emit targeted events only to the author and recipient
(requires per-user SSE filtering or two separate `notify` calls scoped to the relevant users).

### 2. Pagination uses `createdAt` but messages can share the same timestamp

**File**: `apps/api/src/lib/chat/chat.ts`, lines 129-147

`getMessages` paginates with `WHERE createdAt < beforeMsg.createdAt`. If multiple messages share the same
`createdAt` (integer seconds granularity in SQLite), the cursor query can skip messages that have an identical timestamp
to the boundary message.

**Impact**: Messages can be silently lost during pagination in high-throughput rooms.

**Fix**: Use a composite cursor `(createdAt, id)` or add `rowid`-based ordering as a tiebreaker:

```sql
WHERE (createdAt < ? OR (createdAt = ? AND rowid < ?))
ORDER BY createdAt DESC, rowid DESC
```

### 3. `markRead` uses select-then-upsert instead of SQL UPSERT

**File**: `apps/api/src/lib/chat/chat.ts`, lines 230-243

The `markRead` method does a `SELECT` followed by either `UPDATE` or `INSERT`. This is a TOCTOU race condition — two
concurrent `markRead` calls for the same user could both see no existing row and both attempt `INSERT`, causing a
primary key conflict.

**Impact**: Occasional 500 errors when a user has multiple tabs open or rapid read-state updates.

**Fix**: Use SQLite `INSERT ... ON CONFLICT DO UPDATE` (Drizzle's `onConflictDoUpdate`).

### 4. Attachment deletion references `attachmentId` but attachments store file **names**, not pathIds

**File**: `apps/api/src/lib/chat/chat.ts`, lines 209-217

When deleting a message with attachments, the code iterates `existing.attachments` and calls
`this.drive.deleteFile(mountId, attachmentId)` where `attachmentId` is a value from the attachments array. However,
based on the MEDIA-REFERENCES pattern and the frontend code (`use-chat-room.ts` line 79), attachments store **file
names** not pathIds. The `deleteFile` method expects a pathId.

Looking at the test (`chat.test.ts` line 273), the test stores `uploaded.id` (a pathId) — but the frontend stores
`uploaded.name`. This inconsistency means:

- Messages posted from the frontend store names -> `deleteFile` will fail silently (caught by try/catch)
- Messages posted via tests store pathIds -> `deleteFile` works

**Impact**: Attachment cleanup on message deletion silently fails for frontend-posted messages. Orphaned media files
accumulate.

**Fix**: In `deleteMessage`, resolve attachment names to pathIds by looking up the media folder contents, or change the
frontend to store pathIds in the attachments array (breaking the name-based convention from MEDIA-REFERENCES).

## Pattern Violations

### 5. No `maxLength` validation on PATCH message content

**File**: `apps/api/src/routes/chat.ts`, line 64

The POST route has `t.String({maxLength: 50000})` but the PATCH route uses bare `t.String()`:

```typescript
body: t.Object({content: t.String()})  // No maxLength
```

**Impact**: Edited messages can bypass the 50,000 character limit.

**Fix**: Add `{maxLength: 50000}` to the PATCH body schema.

### 6. `chatRouter` does not use the standard Elysia `prefix` option

**File**: `apps/api/src/routes/chat.ts`

Unlike other domain routers that use `.group('/domain', ...)` or `prefix`, every route manually includes `/chat/` in the
path string. This is not a bug but deviates from the typical pattern seen in other domain routers.

### 7. No read permission check on `markRead` endpoint

**File**: `apps/api/src/routes/chat.ts`, lines 78-86

The `/chat/:ownerId/:mountId/:chatId/read` POST endpoint calls `drive.getChat(...)` which checks read permission
internally (via `SharedDrive.getChat`), but it does not verify that the `messageId` in the body actually exists or
belongs to this chat. A user could set `lastReadMessageId` to an arbitrary string.

**Impact**: Low — read state is per-user and only affects the user's own unread indicator. No data corruption, but the
`messageId` is never validated.

**Fix**: Optionally validate that the message exists in the chat before updating read state.

### 8. `buildChatEvent` uses `as SSEvent` type assertion

**File**: `apps/api/src/lib/chat/sse-events.ts`, line 12

```typescript
return {type, title, body: '', chat: data} as SSEvent;
```

This uses a type assertion (`as SSEvent`) instead of letting TypeScript verify the structure. Per CLAUDE.md, `as any` is
forbidden, and while `as SSEvent` is less dangerous, it still bypasses compile-time safety.

**Impact**: If `SSEvent` type changes, this assertion will silently mask type errors.

**Fix**: Use a properly typed return (e.g., with a satisfies check) or ensure the function signature constrains the
return type.

## Security Concerns

### 9. No content sanitization on message content

**File**: `apps/api/src/lib/chat/chat.ts`, line 52 (postMessage) and line 179 (editMessage)

Message content is stored as-is from user input. While the frontend renders via React (which escapes HTML by default),
the content could contain malicious payloads if consumed by a different client or API consumer.

**Impact**: Low if only consumed via React. Medium if content is ever rendered in a non-React context (email
notifications, API consumers, export).

**Recommendation**: Consider server-side sanitization as defense-in-depth.

### 10. Whisper `whisperTo` field accepts userId **or** email inconsistently

**File**: `apps/api/src/lib/chat/chat.ts`, lines 76-84 and 149-155

In `postMessage`, `whisperTo` is validated as an email address. But in `getMessagesForUser` (line 155), the check is:

```typescript
const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
```

This suggests the system should support both userId and email as whisper targets, but the validation at line 77 only
validates email format. The `/whisper` command only accepts email. However, the `whisperTo` body field on the POST
endpoint (`t.Optional(t.String())`) has no format constraint, so a client could pass a userId.

**Impact**: If a client sends `whisperTo: userId`, it passes email validation (UUIDs fail `EMAIL_REGEX`), the request
returns 400. But the `getMessagesForUser` check for `msg.whisperTo === userId` implies someone considered supporting
userId-based whispers. This is dead logic.

**Fix**: Either remove the `msg.whisperTo === userId` check in `getMessagesForUser` (aligning with email-only), or add
support for userId-based whispers.

### 11. No rate limiting on message posting

**File**: `apps/api/src/routes/chat.ts`, line 24

There is no rate limiting on the POST messages endpoint. A user could flood a chat with messages.

**Impact**: DoS potential for chat rooms and database growth.

**Fix**: Add per-user rate limiting to the message POST endpoint.

## Data Integrity

### 12. `getMessagesForUser` fetches all messages then filters whispers client-side

**File**: `apps/api/src/lib/chat/chat.ts`, lines 149-177

The method calls `getMessages(limit, beforeId)` and then transforms whisper content. This means the `limit` parameter
applies before whisper filtering, which is correct (whispers are not filtered out, just redacted). However, for
third-party observers, they still see whisper messages exist with `[a few hushed words]` — this is by design (MUD-style)
but worth noting as an explicit decision.

### 13. `deleteMessage` does not clear `attachments` column

**File**: `apps/api/src/lib/chat/chat.ts`, lines 205-206

When soft-deleting, the code sets `content: ''` and `deletedAt: now` but leaves the `attachments` JSON array intact in
the database. While attachment files are deleted from storage, the metadata (file names/ids) persists in the message
row.

**Impact**: Low — the frontend checks `deletedAt` before rendering attachments. But it leaks attachment file names in
the API response for deleted messages.

**Fix**: Also set `attachments: null` in the update.

### 14. No foreign key constraint between `messages.replyTo` and `messages.id`

**File**: `apps/api/src/lib/chat/db-config.ts`, line 19

The `replyTo` column references another message ID but has no foreign key constraint. Deleting the parent message does
not cascade or prevent orphaned reply references.

**Impact**: Low — the frontend should handle missing reply targets gracefully. But it means `replyTo` can reference
deleted or non-existent messages.

## Code Quality

### 15. `postMessage` has 7 parameters

**File**: `apps/api/src/lib/chat/chat.ts`, line 52

```typescript
async
postMessage(authorId
:
string, authorEmail
:
string, content
:
string,
    type
:
ChatMessage['type'] = 'message', whisperTo ? : string,
    replyTo ? : string, attachments ? : string[]
):
Promise<ChatMessage>
```

Seven positional parameters make the call site hard to read and easy to get wrong.

**Fix**: Accept a single options object:

```typescript
async
postMessage(opts
:
{
    authorId: string;
    authorEmail: string;
    content: string;
...
}
)
```

### 16. Duplicated emote command lists

**File**: `apps/api/src/lib/chat/commands.ts`, lines 62-69

Each built-in emote is checked with a separate `if` statement. The `BUILT_IN_EMOTES` map already contains the keys. The
check could be:

```typescript
if (BUILT_IN_EMOTES[trimmed.slice(1)]) return {kind: 'builtin-emote', emoteKey: trimmed.slice(1)};
```

This would eliminate 8 lines and prevent the emote list from getting out of sync.

### 17. SSE event types `CHAT_MEMBER_ENTERED`, `CHAT_MEMBER_LEFT`, `CHAT_TYPING` are defined but never emitted

**File**: `packages/lib/src/types/sse.ts`, lines 50-52

These event types exist in `SSEventType` and are handled in the frontend SSE handler (`sse-handlers.ts` lines 19-21)
but are never emitted anywhere in the backend.

**Impact**: Dead code. If presence/typing indicators are planned, this is scaffolding; otherwise it should be removed.

## Architecture

### 18. `ChatRoom` class receives `Home` but only uses `home.notify()`

**File**: `apps/api/src/lib/chat/chat.ts`, lines 21-22

The `ChatRoom` constructor takes both `Drive` and `Home`, but `Home` is only used for `this.home.notify()`. The `Drive`
reference is used for file operations and database access.

**Recommendation**: Minor coupling concern. Could accept a `notify` callback instead of the full `Home` instance.

### 19. No pagination metadata returned

**File**: `apps/api/src/lib/chat/chat.ts`, line 146

`getMessages` returns just the message array with no metadata (total count, hasMore indicator). The frontend must infer
"has more" by checking if the returned count equals the limit.

**Impact**: Makes infinite scroll harder to implement correctly. If exactly `limit` messages exist, the client may make
an unnecessary request that returns empty.

**Recommendation**: Return `{ messages, hasMore }` or similar.

## Positive Patterns

- **Clean ACL delegation**: Chat correctly delegates all permission checks to `SharedDrive` rather than implementing its
  own ACL system. This matches the architectural decision documented in `TODO-CHAT-ACL.md`.
- **Comprehensive test coverage**: `chat.test.ts` (728 lines) covers creation, messages, whisper privacy, attachments,
  slash commands, read-only access, emotes, validation, and deletion. Good integration-level testing.
- **Shared validation**: The command parser uses `@workspace/lib/validation` so both frontend and backend share the same
  validation rules, preventing desync.
- **Whisper privacy is server-enforced**: `getMessagesForUser` correctly redacts whisper content for non-participants,
  and the tests verify this (Charlie sees `[a few hushed words]`).
- **Soft delete pattern**: Messages are soft-deleted with content cleared, preserving message history while removing
  sensitive content from storage.

## Recommendations

| Priority | Issue | Description                                                 |
|----------|-------|-------------------------------------------------------------|
| **P1**   | #3    | Use UPSERT for `markRead` to fix TOCTOU race condition      |
| **P0**   | #4    | Fix attachment name vs pathId mismatch in `deleteMessage`   |
| **P0**   | #1    | Fix SSE whisper leakage to non-participants                 |
| **P1**   | #2    | Fix pagination cursor to handle same-timestamp messages     |
| **P1**   | #5    | Add `maxLength` to PATCH body schema                        |
| **P1**   | #13   | Clear `attachments` column on soft delete                   |
| **P2**   | #10   | Remove dead `whisperTo === userId` check or document intent |
| **P2**   | #15   | Refactor `postMessage` to use options object                |
| **P2**   | #17   | Remove or implement unused SSE event types                  |
| **P2**   | #19   | Add pagination metadata to message responses                |
