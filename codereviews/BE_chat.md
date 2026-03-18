# Backend Code Review: Chat

## Summary

The chat domain implements a MUD-inspired chat system where each `.eigenchat` is a Drive folder containing a `data.db`
(SQLite) and a `media/` subfolder. Messages are append-only with SQLite pagination. ACL is inherited from Drive. Slash
commands are parsed server-side for emotes and whispers; other commands (help, time, inspect, invite, reply) are
frontend-only.

The implementation is well-structured and follows Eigen's architecture patterns. The code is clean, the test coverage is
strong, and the ACL model correctly delegates to Drive. There are, however, several issues worth addressing -- one
critical, several important, and a handful of minor items.

**Files reviewed:**

- `apps/api/src/lib/chat/chat.ts` (ChatRoom class)
- `apps/api/src/lib/chat/commands.ts` (slash command parsing)
- `apps/api/src/lib/chat/schema.ts` (Drizzle schema)
- `apps/api/src/lib/chat/db-config.ts` (DB config + migrations)
- `apps/api/src/lib/chat/sse-events.ts` (SSE event builder)
- `apps/api/src/lib/chat/index.ts` (exports)
- `apps/api/src/routes/chat.ts` (API routes)
- `apps/api/src/test/chat.test.ts` (chat tests)
- `apps/api/src/test/command-validation.test.ts` (command validation unit tests)
- `apps/api/src/test/integration.test.ts` (cross-domain integration tests)
- `packages/lib/src/types/chat.ts` (shared types)
- `packages/lib/src/validation/command.ts` (shared command validation)
- `packages/lib/src/validation/email.ts` (email validation)
- `packages/lib/src/core/chat/commands.ts` (frontend command helpers)
- `apps/api/src/lib/drive/sharedDrive.ts` (SharedDrive ACL wrapper)
- `apps/api/src/lib/drive/get-drive.ts` (getSharedDrive factory)

## Architecture Compliance

The chat domain follows the established patterns well:

- **Domain class**: `ChatRoom` in `apps/api/src/lib/chat/chat.ts` -- correct location and structure.
- **Schema**: `apps/api/src/lib/chat/schema.ts` with Drizzle ORM -- follows convention.
- **DB config**: `apps/api/src/lib/chat/db-config.ts` with `CHAT_ROOM_DB_CONFIG` -- correct pattern.
- **Routes**: `apps/api/src/routes/chat.ts` -- thin router delegating to domain class, `{auth: true}` on all routes.
- **SSE events**: `apps/api/src/lib/chat/sse-events.ts` uses `buildChatEvent` with proper `SSEventType` constants.
- **Shared types**: `packages/lib/src/types/chat.ts` used by both FE and BE.
- **Validation**: `packages/lib/src/validation/command.ts` shared between FE and BE -- good.
- **ACL inheritance**: Chat ACL delegates to Drive ACL via `SharedDrive.getChat()` and explicit `canWrite()` checks in
  routes.

One deviation: `ChatRoom` receives `Home` directly in its constructor (line 26 of `chat.ts`), whereas most domain
classes are accessed _through_ Home. This is fine given that `ChatRoom` is instantiated per-request by `Drive.getChat()`
rather than being a singleton service.

## Issues Found

### Critical

**1. Whisper content leaks to all SSE subscribers**

`apps/api/src/lib/chat/chat.ts`, lines 116-122.

When a message is posted, the full `ChatMessage` object -- including whisper content and `whisperTo` field -- is
broadcast via SSE to `home.notify()`. The SSE event is broadcast to _all_ connected users of that home, not just the
whisper author and recipient.

While `getMessagesForUser()` correctly filters whisper content for REST API responses (lines 146-173), the SSE event
payload at line 116-122 contains the unfiltered message:

```typescript
this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_POSTED, {
    chatId: this.path.id,
    ownerId: this.path.ownerId,
    mountId: this.path.mountId,
    message,  // <-- full whisper content visible to all SSE subscribers
}));
```

Any user subscribed to the SSE stream for that home will receive the whisper content in real time, bypassing the REST
endpoint's whisper filtering. A user could observe whispers directed at others simply by reading the SSE event stream.

**Fix**: Either strip whisper content from the SSE payload (and let clients re-fetch via the REST API), or emit
separate SSE events to author/recipient with full content and to everyone else with redacted content.

### Important

**2. Clients can post `system` type messages**

`apps/api/src/routes/chat.ts`, lines 40-45.

The route schema allows `type: 'system'` as a valid message type:

```typescript
type: t.Optional(t.Union([
    t.Literal('message'),
    t.Literal('emote'),
    t.Literal('whisper'),
    t.Literal('system'),  // <-- any authenticated user can post system messages
])),
```

There is no server-side check preventing a regular user from posting messages with `type: 'system'`. System messages
should be reserved for server-generated content (e.g., "X joined the room"). Allowing clients to spoof system messages
enables social engineering attacks within chat rooms.

**Fix**: Remove `t.Literal('system')` from the accepted `type` union in the route schema, or add server-side validation
that rejects client-submitted `system` type messages.

**3. No message content length limit**

`apps/api/src/routes/chat.ts`, line 39 and `apps/api/src/lib/chat/chat.ts`, line 52.

The `content` field is validated only as `t.String()` with no `maxLength` constraint. A user could post arbitrarily
large messages (megabytes of text), which would:

- Bloat the per-chat SQLite database.
- Cause memory pressure when loading messages (the entire content is returned in API responses).
- Potentially be used for denial-of-service against other users loading the chat.

**Fix**: Add `t.String({maxLength: N})` to the route body schemas for both POST and PATCH. A reasonable limit might be
10,000-50,000 characters.

**4. `reply` and `invite` slash commands are parsed but silently stored as regular messages**

`apps/api/src/lib/chat/chat.ts`, lines 53-73.

The `parseCommand()` function returns `{kind: 'reply', ...}` and `{kind: 'invite', ...}` for `/reply` and `/invite`
commands. However, the `switch` in `postMessage()` only handles `builtin-emote`, `emote`, `whisper`, and `error`. The
`reply` and `invite` kinds fall through to `default: break`, meaning the raw slash command text (e.g.,
`/invite bob@example.com`) is stored verbatim as a regular message.

This is inconsistent with the documentation in `docs/CHAT.md` (lines 92-93) which says `/reply` and `/invite` are
frontend-only commands. If the frontend correctly intercepts these commands, they should never reach the backend. But
the backend should still handle them defensively rather than storing the raw command text.

**Fix**: Either add explicit `case 'reply':` and `case 'invite':` handlers that throw an `ApiError(400, ...)` to reject
them, or add a `case 'reply': case 'invite': return` that discards them. Rejecting with a 400 is safer.

**5. No `limit` parameter validation / capping**

`apps/api/src/routes/chat.ts`, line 12.

```typescript
const limit = query.limit ? parseInt(query.limit) : 50;
```

The `limit` query parameter is parsed with `parseInt` but never validated. A client could pass `limit=999999` to fetch
all messages in a single request, or `limit=-1` / `limit=NaN` (from non-numeric strings) which would cause unexpected
behavior with SQLite's `LIMIT` clause. Negative values in SQLite's LIMIT return all rows.

**Fix**: Clamp the parsed value: `const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 200)`.

**6. `whisperTo` stores email but checks against both userId and email**

`apps/api/src/lib/chat/chat.ts`, lines 76-83 and 151-152.

Whisper targets are stored as email addresses (validated at line 77, looked up at line 80). However, the recipient check
at line 152 compares against both `userId` and `userEmail`:

```typescript
const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
```

Since `whisperTo` always contains an email address (enforced by `validateEmailAddress`), the `msg.whisperTo === userId`
comparison will never be true. This is dead code that makes the intent unclear and could mask bugs if the storage format
ever changes.

**Fix**: Remove the `msg.whisperTo === userId` check, or change the storage to use userId for consistency with other
ID-based lookups.

### Minor

**7. `editMessage` does not prevent editing deleted messages**

`apps/api/src/lib/chat/chat.ts`, lines 176-195.

The `editMessage` method checks that the message exists and that the author matches, but it does not check whether the
message has been soft-deleted (`deletedAt !== null`). A user could edit a message that was already deleted, which would
update its content while leaving `deletedAt` set -- creating an inconsistent state where a "deleted" message has new
content.

**Fix**: Add `if (existing.deletedAt) return null;` after the ownership check.

**8. `editMessage` does not prevent editing whisper/emote/system messages**

`apps/api/src/lib/chat/chat.ts`, line 176.

Users can edit whisper messages, emote messages, and system messages. Editing a whisper could change its content after
the recipient has already read it, which is unexpected. Editing an emote built-in (stored as `$dance`) to arbitrary text
would break the emote rendering logic.

**Fix**: Consider restricting edits to `type === 'message'` only, or at minimum prevent editing built-in emotes.

**9. Pagination uses `createdAt` timestamp which is not unique**

`apps/api/src/lib/chat/chat.ts`, lines 128-135.

The `getMessages` method paginates by looking up the `createdAt` of the `beforeId` message and then fetching all
messages with `createdAt < beforeMsg.createdAt`. If two messages share the exact same `createdAt` timestamp (possible
with fast sequential inserts, especially at second granularity since SQLite stores `unixepoch()` as seconds), the cursor
message itself and its timestamp-twins could be either skipped or duplicated across pages.

**Fix**: Use a compound cursor of `(createdAt, id)` with `(createdAt < beforeCreatedAt) OR (createdAt = beforeCreatedAt AND id < beforeId)` ordering, or switch to a `ROWID`-based cursor.

**10. No `content` emptiness check for regular messages**

`apps/api/src/lib/chat/chat.ts`, line 52 and `apps/api/src/routes/chat.ts`, line 39.

An empty string `""` is a valid `t.String()`. Users can post messages with empty content. While harmless from a data
integrity standpoint, it creates blank chat messages that clutter the UI.

**Fix**: Add `t.String({minLength: 1})` to the route schema, or add a check in `postMessage`.

**11. `markRead` does not validate that the messageId exists**

`apps/api/src/lib/chat/chat.ts`, lines 227-241.

The `markRead` method blindly stores any `messageId` string in the `read_state` table without verifying that the message
actually exists in the `messages` table. A client could pass an invalid or forged message ID.

**Fix**: Add a check that the referenced message exists before storing the read state.

**12. `deleteMessage` SSE event includes content from before deletion**

`apps/api/src/lib/chat/chat.ts`, lines 217-222.

The delete event is built from `{...existing, deletedAt: now}` but does not clear the `content` field in the SSE
payload. The database write at line 203-204 correctly sets `content: ''`, but the SSE event still contains the original
`existing.content`. This means SSE subscribers briefly receive the content of a "deleted" message.

**Fix**: Build the SSE payload from `{...existing, deletedAt: now, content: ''}` to match what is stored.

**13. `ChatRoom.create` is not atomic**

`apps/api/src/lib/chat/chat.ts`, lines 32-35.

The static `create` method calls `touchFile` and then `createFolder` sequentially. If the second call fails, the chat
is left in a half-initialized state (has `data.db` but no `media/` folder). The `init()` method (line 37) partially
mitigates this by auto-creating missing `data.db`, but there is no equivalent recovery for a missing `media/` folder.

**14. Built-in emote commands are duplicated across three files**

The list of built-in emote names appears in:
- `apps/api/src/lib/chat/commands.ts` lines 62-69 (parsing)
- `packages/lib/src/validation/command.ts` line 15 (validation)
- `apps/api/src/lib/chat/commands.ts` lines 8-41 (definitions)

And the frontend command list at `packages/lib/src/core/chat/commands.ts` lines 25-26. Adding a new emote requires
updating all locations. Consider extracting the emote names into a shared constant.

## Robustness

**Strengths:**
- Whisper validation is thorough: email format validation + user existence check before storage.
- Soft delete correctly clears content in the database, preventing data recovery from the REST API.
- Attachment cleanup on message delete is wrapped in try/catch, handling already-deleted files gracefully.
- `ChatRoom.init()` auto-creates `data.db` if missing, providing self-healing behavior.
- `SharedDrive.getChat()` enforces read permission before returning a `ChatRoom` instance.
- The `validateCommand` function is shared between FE and BE, preventing parsing drift.

**Weaknesses:**
- No rate limiting on message posting -- a client could flood a chat room.
- No concurrent write protection -- two simultaneous `postMessage` calls could theoretically interleave, though SQLite's
  WAL mode + busy_timeout mitigates this in practice.
- The `getChat` method at `apps/api/src/lib/drive/drive.ts:202` creates a new `ChatRoom` instance on every call, opening
  the database each time. The `ManagedDatabase` singleton pattern should prevent duplicate opens, but it means every API
  call pays the cost of `init()`.

## Test Coverage

**Well covered:**
- Chat creation (standalone + embedded in docs): structure, MIME types, internal file layout.
- Message CRUD: post, get, edit, soft-delete.
- Whisper visibility: author sees content, recipient sees "whispers to you", third party sees "[a few hushed words]".
- Slash commands: all 8 built-in emotes, `/me` custom emote, `/whisper` + aliases, invalid commands.
- ACL enforcement: read-only user cannot post/edit/delete, ACL upgrade grants access.
- Attachments: upload + post, retrieval, cleanup on message delete.
- Backend validation: non-email whisper targets, non-existent users, content clearing on delete.
- Cross-domain integration: Drive + Chat permission synchronization.
- Command validation unit tests: all valid commands, all invalid states, edge cases.

**Missing test scenarios:**
1. **Pagination**: No tests for `?before=` cursor pagination or `?limit=` parameter.
2. **Empty content**: No test for posting a message with empty string content.
3. **Editing deleted messages**: No test verifying that editing a deleted message is handled correctly.
4. **System message spoofing**: No test verifying that clients cannot post `type: 'system'` messages.
5. **SSE event content**: No tests verify the content of SSE events (whisper leak, delete content leak).
6. **Concurrent access**: No tests for simultaneous writes to the same chat room.
7. **`markRead` with invalid messageId**: No test for marking a non-existent message as read.
8. **Very large limit values**: No test for `?limit=999999` or negative/NaN limit values.
9. **Editing emote/whisper messages**: No tests for editing special message types.
10. **`replyTo` validation**: No test verifying that the `replyTo` message ID actually exists.

## Recommendations

1. **Fix the whisper SSE leak** (Critical) -- This is a real privacy bug. Either strip whisper data from SSE events or
   emit targeted events per user.

2. **Remove `system` from the accepted message types** in the route schema. System messages should only be created
   server-side.

3. **Add content length limits** to both the POST and PATCH route schemas to prevent abuse.

4. **Reject `reply` and `invite` commands** at the backend with a 400 error rather than silently storing them as raw
   text.

5. **Cap the `limit` query parameter** to a reasonable maximum (e.g., 200) and validate it as a positive integer.

6. **Add pagination tests** -- this is a core chat feature (infinite scroll) with zero test coverage.

7. **Prevent editing of deleted messages** in `editMessage`.

8. **Clear content in the delete SSE event** to match what is stored in the database.

9. **Extract emote names into a shared constant** to reduce duplication across validation, parsing, and definition
   files.

10. **Consider adding a `minLength: 1` constraint** to message content in the route schema.
