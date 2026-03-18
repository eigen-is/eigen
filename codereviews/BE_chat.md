# Backend Review: Chat (Rooms, Messages, Slash Commands)

**Scope:** `apps/api/src/lib/chat/`, `apps/api/src/routes/chat.ts`
**Reviewed:** 2026-03-18

**Files reviewed:**

- `apps/api/src/lib/chat/chat.ts` -- ChatRoom class (business logic)
- `apps/api/src/lib/chat/commands.ts` -- slash command parsing + emote formatting
- `apps/api/src/lib/chat/schema.ts` -- Drizzle ORM schema (messages + read_state)
- `apps/api/src/lib/chat/db-config.ts` -- database config + migration v1
- `apps/api/src/lib/chat/sse-events.ts` -- SSE event builder
- `apps/api/src/lib/chat/index.ts` -- barrel exports
- `apps/api/src/routes/chat.ts` -- API route handlers
- `apps/api/src/lib/home/home.ts` -- Home.notify() + SSE listener management
- `apps/api/src/routes/sse.ts` -- SSE subscription endpoint
- `apps/api/src/lib/drive/drive.ts` -- Drive.getChat() factory
- `apps/api/src/lib/drive/sharedDrive.ts` -- SharedDrive ACL enforcement
- `apps/api/src/lib/drive/get-drive.ts` -- getSharedDrive() factory
- `apps/api/src/lib/user/user.ts` -- getUserByEmail()
- `packages/lib/src/types/chat.ts` -- shared ChatMessage type
- `packages/lib/src/types/sse.ts` -- SSEvent types + SSEventChatData
- `packages/lib/src/validation/command.ts` -- shared command validation
- `packages/lib/src/validation/email.ts` -- email validation
- `packages/lib/src/core/chat/commands.ts` -- frontend command helpers
- `packages/lib/src/core/chat/hooks/use-chat.ts` -- query hooks + SSE invalidation
- `packages/lib/src/core/chat/hooks/use-chat-room.ts` -- room-level hook
- `packages/lib/src/core/chat/sse-handlers.ts` -- frontend SSE handler
- `packages/lib/src/core/sse/hooks/use-sse.ts` -- SSE subscription hook
- `apps/api/src/test/chat.test.ts` -- integration tests
- `apps/api/src/test/command-validation.test.ts` -- unit tests

---

## Critical Issues

### 1. Whisper content in SSE events -- latent privacy leak (Reclassified from previous: was Critical)

`apps/api/src/lib/chat/chat.ts:116-122`

The previous review flagged this as a critical active exploit. After tracing the full SSE path, the actual
severity is lower but the underlying code defect is real and will become critical if the SSE architecture changes.

**Full trace:**

1. `ChatRoom.postMessage()` (chat.ts:116) calls `this.home.notify(buildChatEvent(..., { message }))` with the
   full unfiltered `ChatMessage`, including `whisperTo` and plaintext `content`.
2. `this.home` is the Home instance of the *owner* of the chat, set at `Drive.getChat()` (drive.ts:208):
   `new ChatRoom(this, this.home, path)`.
3. `Home.notify()` (home.ts:166-169) broadcasts to `this.sseListeners` -- all SSE subscribers on *that* Home.
4. The SSE route (sse.ts:8-13) subscribes to `getHome(user.id)` -- the *authenticated user's own* Home, ignoring
   the `ownerId` URL parameter entirely.
5. The frontend `useSSE` hook (use-sse.ts:41) calls `getSSEEventsUrl(user.id)`, subscribing only to its own Home.

**Current impact:** For user-owned chats (Alice's chat), the SSE event fires on Alice's Home. Only Alice's own
SSE connection receives it. Bob, even if he has access to Alice's chat, subscribes to Bob's Home and never sees
the event. For team chats (`team_xxx`), the event fires on TeamHome; currently no user subscribes to team SSE
streams, so the event goes nowhere.

**Why this is still a real defect:**

- The SSE payload objectively contains unfiltered whisper content. Any future change to the SSE model (e.g.,
  adding team SSE subscriptions, adding a shared-home SSE stream, or exposing SSE events to admins) would
  immediately create an active whisper leak.
- The frontend SSE handler (`sse-handlers.ts:13-16`) receives the full `SSEventChatData` including the `message`
  field. While the handler currently only calls `invalidateMessages()` (discarding the message payload), any
  future handler that surfaces the SSE message data (e.g., for toast previews or optimistic updates) would
  expose whisper content.
- The mismatch between the REST API (which filters whispers in `getMessagesForUser`) and the SSE API (which
  does not filter) is a correctness bug regardless of current exploitability.

**Fix:** Strip whisper content from the SSE payload. The simplest approach: when `type === 'whisper'`, emit the
event with `content: ''` and `whisperTo: null`, forcing clients to re-fetch via the REST API (which correctly
filters). This is safe because the SSE handler already triggers a query invalidation that re-fetches messages.

### 2. Clients can post `system` type messages (Retained from previous)

`apps/api/src/routes/chat.ts:40-45`

The POST route schema accepts `t.Literal('system')` in the `type` union:

```typescript
type: t.Optional(t.Union([
    t.Literal('message'),
    t.Literal('emote'),
    t.Literal('whisper'),
    t.Literal('system'),
]))
```

No server-side guard prevents a user from posting messages with `type: 'system'`. These render differently in the
UI (no author attribution), enabling social engineering: a malicious user could post "Alice has been removed from
the room" or "System maintenance in 5 minutes" as system messages indistinguishable from real ones.

The schema type also includes `system` in `schema.ts:8` and `ChatMessageType` in `packages/lib/src/types/chat.ts:1`,
so the type system allows it everywhere.

**Impact:** Social engineering within chat rooms. Any user with write access can impersonate system messages.

**Fix:** Remove `t.Literal('system')` from the route body schema. If `system` messages are needed, create them
only server-side (e.g., in join/leave handlers). The frontend already creates local system messages client-side
(use-chat-room.ts:41-56) and does not need to POST them.

---

## Important Issues

### 3. No message content length limit (Retained from previous)

`apps/api/src/routes/chat.ts:39` (POST) and `apps/api/src/routes/chat.ts:63` (PATCH)

The `content` field is `t.String()` with no `maxLength`. A client can POST megabytes of text as a single message.
This bloats the per-chat SQLite database, causes memory pressure when loading messages (all content is returned
inline), and can be used as a denial-of-service against other users scrolling the chat.

The PATCH route (line 63) also uses `t.String()` for the edit body with no limit, allowing the same abuse via
editing existing messages.

**Impact:** DoS against chat participants. Database growth. Memory pressure.

**Fix:** Add `t.String({maxLength: 50000})` to both POST and PATCH schemas.

### 4. `/reply` and `/invite` commands silently stored as regular messages (Retained from previous, refined)

`apps/api/src/lib/chat/commands.ts:87-99` and `apps/api/src/lib/chat/chat.ts:53-73`

`parseCommand()` returns `{kind: 'reply', ...}` and `{kind: 'invite', ...}` for these commands. But the `switch`
in `postMessage()` (chat.ts:55-73) only handles `builtin-emote`, `emote`, `whisper`, and `error`. The `reply`
and `invite` cases fall through to `default: break`, causing the raw command text to be stored verbatim as a
regular message visible to all participants.

Example: if the frontend fails to intercept `/invite bob@example.com`, it reaches the backend and gets stored as
a plaintext message reading "/invite bob@example.com" -- leaking the intended private action.

The documentation (CHAT.md:92-93) says these are frontend-only commands, but the backend should reject them
defensively.

**Impact:** Unintended data leakage (invite targets, reply content stored as public messages).

**Fix:** Add `case 'reply': case 'invite': throw new ApiError(400, 'This command is handled client-side');` to
the switch statement in `postMessage()`.

### 5. No `limit` parameter validation or capping (Retained from previous, expanded)

`apps/api/src/routes/chat.ts:12`

```typescript
const limit = query.limit ? parseInt(query.limit) : 50;
```

Problems:
- `parseInt('abc')` returns `NaN`. SQLite's `LIMIT NaN` may behave unpredictably or return 0 rows.
- `parseInt('-1')` returns `-1`. SQLite's `LIMIT -1` returns all rows -- a full table dump.
- `parseInt('999999')` returns 999999. For a large chat, this fetches all messages in one response.
- `parseInt('3.7')` returns `3`, which is fine, but shows the loose parsing.

**Impact:** Excessive memory use, potential DoS. Negative limit enables full message dump bypassing pagination.

**Fix:** `const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 200);`

### 6. `deleteMessage` SSE event leaks pre-deletion content (Retained from previous)

`apps/api/src/lib/chat/chat.ts:217-222`

```typescript
this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_DELETED, {
    chatId: this.path.id,
    ownerId: this.path.ownerId,
    mountId: this.path.mountId,
    message: this.toMessage({...existing, deletedAt: now}),
}));
```

The database write at line 203 sets `content: ''`, but the SSE event is built from `{...existing, deletedAt: now}`
which retains the original `existing.content`. Any SSE consumer that inspects the message payload receives the
content of a "deleted" message.

Currently this has the same limited SSE exposure as issue #1 (only the owner's Home), but the payload is
objectively wrong -- it does not match the database state.

**Impact:** SSE payload inconsistency. Content of deleted messages visible in SSE stream.

**Fix:** Build the payload as `this.toMessage({...existing, deletedAt: now, content: ''})`.

### 7. `whisperTo` dead-code comparison against userId (Retained from previous)

`apps/api/src/lib/chat/chat.ts:152`

```typescript
const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
```

`whisperTo` is always an email address (enforced by `validateEmailAddress` at line 77). The `msg.whisperTo === userId`
check compares an email against a UUID -- this will never be true. It is dead code that obscures the actual logic.

**Impact:** Code clarity. If someone changes the storage format to user IDs, they might assume this code already
handles it and miss updating other code paths.

**Fix:** Remove the `msg.whisperTo === userId` comparison.

### 8. `markRead` endpoint accepts any string as messageId (Retained from previous)

`apps/api/src/lib/chat/chat.ts:227-241` and `apps/api/src/routes/chat.ts:77-85`

The `markRead` method stores the `messageId` directly in `read_state` without verifying the message exists.
A client can pass arbitrary strings (including message IDs from other chats or entirely fabricated IDs).
While this doesn't cause a security breach, it corrupts the read-state tracking and could cause UI bugs
(e.g., "unread" badge calculations based on comparing IDs).

Additionally, the `markRead` route at line 77-80 only requires read permission (via `drive.getChat()` which
checks `canRead`), not write permission. This is arguably correct -- marking a message as read is a user-specific
action, not a write to the chat. But it's worth noting explicitly.

**Impact:** Potential read-state corruption. Minor.

**Fix:** Add a check that the message exists: `const msg = await this.db.select()...where(eq(schema.messages.id, messageId)).get(); if (!msg) return;`

### 9. Validation/parsing mismatch for `/me` prefix (New)

`packages/lib/src/validation/command.ts:31` vs `apps/api/src/lib/chat/commands.ts:72`

The shared `validateCommand` function uses `trimmed.startsWith('/me')` (no trailing space), while the backend
`parseCommand` uses `trimmed.startsWith('/me ')` (with space). This means:

- `/me dances` -- validation: valid emote, parsing: valid emote. Correct.
- `/me` -- validation: caught as error ("requires action"). Correct.
- `/meet` -- validation: valid emote (matches `/me` prefix), parsing: does not match `/me ` prefix, falls through
  to error return. Mismatch.

The mismatch means `validateCommand` declares `/meet` valid, so the frontend won't show an "unknown command"
error via `isUnknownCommand()` (which checks first). But when the backend's `parseCommand` processes it, it
falls through and returns `{kind: 'error', error: 'Unknown command'}`, which throws ApiError(400).

The user experience is: the frontend allows submission, the backend rejects it with a 400.

**Impact:** Poor UX for edge-case inputs. The backend correctly rejects the input, so no data corruption.

**Fix:** Change `validateCommand` to use `trimmed.startsWith('/me ')` with a trailing space, matching the backend.

### 10. Validation prefix matching for `/r` catches unrelated commands (New)

`packages/lib/src/validation/command.ts:67`

```typescript
if (trimmed.startsWith('/reply') || trimmed.startsWith('/r')) {
```

`startsWith('/r')` matches `/r`, `/reply`, `/run`, `/read`, etc. Since built-in emotes and whisper commands are
checked first, the main risk is that any unknown `/r`-prefixed command (e.g., `/rtfm message`) is accepted as a
valid `reply` command by the validator. The backend's `parseCommand` only checks `/reply ` and `/r ` (with
spaces), so `/rtfm` would not match and would fall through to the error return.

Same class of bug as issue #9 -- validation is more permissive than parsing.

**Impact:** Same as #9 -- false validation acceptance, backend 400.

**Fix:** Change to `trimmed.startsWith('/reply ') || trimmed.startsWith('/r ')` with trailing spaces, plus exact
checks for `/reply` and `/r` (no args).

---

## Minor Issues

### 11. `editMessage` does not prevent editing deleted messages (Retained from previous)

`apps/api/src/lib/chat/chat.ts:176-178`

```typescript
const existing = await this.db.select()...where(eq(schema.messages.id, messageId)).get();
if (!existing || existing.authorId !== userId) return null;
```

No check for `existing.deletedAt`. A user can edit a soft-deleted message, setting new content while `deletedAt`
remains set. The UI shows "This message was deleted" for messages with `deletedAt`, but the database now contains
real content in a "deleted" message -- an inconsistent state.

**Fix:** Add `if (existing.deletedAt) return null;` after line 178.

### 12. `editMessage` allows editing built-in emotes into arbitrary text (Retained from previous)

`apps/api/src/lib/chat/chat.ts:176`

A built-in emote is stored as `$dance`, `$shrug`, etc. The `formatEmoteForViewer` function (commands.ts:108-119)
looks up the `$` prefix to render first/third person text. If a user edits a built-in emote to arbitrary content
(e.g., changes `$dance` to `hello world`), the emote rendering falls through to the `${authorName} ${content}`
branch (line 119), which still works but produces unexpected output for what was originally a built-in emote.

Editing whispers is also allowed, which lets an author change the whisper content after the recipient has read it.

**Impact:** Semantic inconsistency. Low severity.

**Fix:** Restrict edits to `type === 'message'` only, or at minimum reject edits to built-in emotes (content
starting with `$`).

### 13. Pagination cursor uses non-unique `createdAt` timestamp (Retained from previous)

`apps/api/src/lib/chat/chat.ts:128-135`

Pagination uses `createdAt < beforeMsg.createdAt`. The `createdAt` column stores Unix timestamps at second
granularity (SQLite `unixepoch()`). If two messages share the same second, the cursor can skip or duplicate
messages across pages.

In practice, the code uses `new Date()` from JavaScript (millisecond precision) with `{mode: 'timestamp'}` in
Drizzle, which stores as a Unix timestamp in seconds. Fast sequential inserts within the same second will collide.

**Fix:** Use a compound cursor: `WHERE (createdAt < ?) OR (createdAt = ? AND id < ?) ORDER BY createdAt DESC, id DESC`.

### 14. Empty string content allowed for regular messages (Retained from previous)

`apps/api/src/routes/chat.ts:39`

`t.String()` accepts empty strings. Users can post completely blank messages.

**Fix:** Use `t.String({minLength: 1})` for the POST body's `content` field. Do *not* add this to PATCH -- the
soft-delete flow sets `content: ''` internally.

### 15. `ChatRoom.create` is not atomic (Retained from previous)

`apps/api/src/lib/chat/chat.ts:32-35`

```typescript
static async create(drive: Drive, mountId: string, roomId: string): Promise<void> {
    await drive.touchFile(mountId, roomId, 'data.db', 'application/x-sqlite3');
    await drive.createFolder(mountId, roomId, 'media');
}
```

If `createFolder` fails after `touchFile` succeeds, the chat has `data.db` but no `media/` folder. The `init()`
method (line 37) auto-creates `data.db` if missing, but there is no equivalent recovery for a missing `media/`
folder. Attachment uploads would fail silently.

**Impact:** Low -- the failure mode is rare and attachment uploads would error clearly.

**Fix:** Wrap in a try/catch that cleans up `data.db` if `createFolder` fails, or add `media/` recovery to `init()`.

### 16. Built-in emote names duplicated across four locations (Retained from previous)

The eight built-in emote names appear in:
- `apps/api/src/lib/chat/commands.ts:62-69` -- individual `if` checks in `parseCommand`
- `apps/api/src/lib/chat/commands.ts:8-41` -- `BUILT_IN_EMOTES` definitions
- `packages/lib/src/validation/command.ts:15` -- `builtinEmotes` array in `validateCommand`
- `packages/lib/src/core/chat/commands.ts:25-26` -- `SLASH_COMMANDS` array on frontend

Adding a new emote requires updating all four files. The `BUILT_IN_EMOTES` keys (commands.ts:8-41) could serve
as the single source of truth if exported to `packages/lib`.

**Fix:** Extract the emote name list into a shared constant in `packages/lib/src/constants/` or
`packages/lib/src/validation/`, and import it everywhere.

### 17. SSE route ignores `ownerId` URL parameter (New -- observation)

`apps/api/src/routes/sse.ts:8-13`

The route is `/sse/:ownerId/events` but the handler uses `getHome(user.id)`, completely ignoring `params.ownerId`.
This means a user could request `/sse/anyone/events` and still only receive their own events. The `ownerId`
parameter is dead -- it serves no purpose and is misleading.

The frontend always passes `user.id` as the ownerId (use-sse.ts:41), so this is not exploitable. But it means
SSE events for shared resources (team chats, shared drives) are never delivered to non-owner participants.
The frontend works around this with `refetchInterval: 5000` polling (use-chat.ts:34).

**Impact:** Misleading API surface. Team/shared-resource SSE events are silently dropped.

**Fix:** Either use `params.ownerId` (with authorization checks) to subscribe to the correct Home, or remove the
`ownerId` parameter from the route since it is unused.

---

## Observations

**Architecture compliance:** The chat domain follows established patterns well. Domain class in the correct
location, thin route handler delegating to business logic, proper `{auth: true}` on all routes, shared types in
`packages/lib`, SSE events using the standard builder pattern.

One intentional deviation: `ChatRoom` is instantiated per-request by `Drive.getChat()` (drive.ts:202-210) rather
than being a singleton. This means every API call pays `init()` cost (database open). The `ManagedDatabase`
singleton pattern prevents duplicate opens, but there is overhead in the lookup path. Acceptable given chat
databases are small.

**ACL enforcement:** Solid. `SharedDrive.getChat()` enforces `canRead` before returning a `ChatRoom` instance
(sharedDrive.ts:156-161). All mutating routes (POST, PATCH, DELETE) additionally check `canWrite` before
proceeding (routes/chat.ts:24-26, 55-56, 69-70). The only write-like action without a `canWrite` check is
`markRead` (line 77-80), which is a per-user state update rather than a chat mutation -- this is correct.

**Whisper validation:** Thorough. The `postMessage` flow validates email format (`validateEmailAddress`), then
verifies the user exists (`getUserByEmail`), all before any database write. Failed whispers return 400/404
without storing any data.

**Soft delete:** Correctly clears content in the database (line 203), preventing data recovery via the REST API.
Attachment files are cleaned up with proper error handling for already-deleted files (lines 206-214).

**Test coverage:** Strong for the core paths. 120+ assertions across creation, CRUD, whisper visibility, slash
commands, ACL enforcement, attachments, and validation. Notable gaps: pagination, system message spoofing, empty
content, limit parameter edge cases, editing deleted/special messages, and SSE event payloads.
