# Backend Review: Chat (Rooms, Messages, Slash Commands)

**Scope:** `apps/api/src/lib/chat/`, `apps/api/src/routes/chat.ts`
**Reviewed:** 2026-03-19
**Previous review:** 2026-03-18 (this is a full re-review against current code)

**Files reviewed:**

- `apps/api/src/lib/chat/chat.ts` -- ChatRoom class (business logic)
- `apps/api/src/lib/chat/commands.ts` -- slash command parsing + emote formatting
- `apps/api/src/lib/chat/schema.ts` -- Drizzle ORM schema (messages + read_state)
- `apps/api/src/lib/chat/db-config.ts` -- database config + migration v1
- `apps/api/src/lib/chat/sse-events.ts` -- SSE event builder
- `apps/api/src/lib/chat/index.ts` -- barrel exports
- `apps/api/src/routes/chat.ts` -- API route handlers
- `apps/api/src/lib/drive/drive.ts` -- Drive.getChat() factory
- `apps/api/src/lib/drive/sharedDrive.ts` -- SharedDrive ACL enforcement
- `apps/api/src/lib/drive/get-drive.ts` -- getSharedDrive() factory
- `apps/api/src/lib/user/user.ts` -- getUserByEmail()
- `packages/lib/src/types/chat.ts` -- shared ChatMessage type
- `packages/lib/src/types/sse.ts` -- SSEvent types + SSEventChatData
- `packages/lib/src/validation/command.ts` -- shared command validation
- `packages/lib/src/validation/email.ts` -- email validation
- `apps/api/src/test/chat.test.ts` -- integration tests (728 lines)
- `apps/api/src/test/command-validation.test.ts` -- unit tests (168 lines)

---

## Architecture Overview

### ChatRoom class

`ChatRoom` (`apps/api/src/lib/chat/chat.ts`) is the domain class for a single chat room. Each `.eigenchat` Drive folder
is one room with its own SQLite database (`data.db`) and `media/` subfolder for attachments.

Lifecycle:

1. `ChatRoom.create()` -- static factory that creates `data.db` and `media/` folder inside an existing `.eigenchat`
   Drive folder.
2. `new ChatRoom(drive, home, path).init()` -- resolves or auto-creates `data.db`, opens the `ManagedDatabase`, and
   returns the ready instance.
3. Instantiated per-request by `Drive.getChat()` (`drive.ts:206-214`). Not a singleton -- but `ManagedDatabase`'s
   internal singleton pattern prevents duplicate DB opens.

### Message types

Four types: `message` (normal text), `emote` (custom or built-in), `whisper` (private to sender+recipient), `system` (
server-generated). The schema (`schema.ts:8`) defines all four. The route body schema (`routes/chat.ts:40-44`) only
accepts `message`, `emote`, and `whisper` -- `system` is correctly excluded from client input.

### Slash commands

Backend-processed commands (`commands.ts`): `parseCommand()` recognizes built-in emotes (`/dance`, `/cheer`, `/taunt`,
`/greet`, `/allthethings`, `/facepalm`, `/shrug`, `/flip`), custom emotes (`/me`), and whispers (`/whisper`, `/w`,
`/tell`, `/t`, `/send`). Also recognizes `/reply` and `/invite` as frontend-only commands but does not handle them in
the `postMessage` switch.

Shared validation (`packages/lib/src/validation/command.ts`): `validateCommand()` runs on both frontend and backend.
Validates email targets for whispers, invites, and inspect commands.

### Whispers

Whisper privacy is enforced at the read layer. `getMessagesForUser()` (`chat.ts:149-177`) returns all messages but
transforms whisper content:

- Author sees: `"whispers to {name}: {content}"`
- Recipient sees: `"whispers to you: {content}"`
- Third parties see: `"whispers to {name}: [a few hushed words]"` with `whisperTo: null`

The SSE event for whisper posts (`chat.ts:116-118`) now strips content and whisperTo before broadcasting.

### Embedded chats

Eigen documents and stickies auto-create a `chat/` subfolder with a "General" chat. The `ChatRoom.init()` method
auto-creates `data.db` if missing, providing lazy initialization for embedded chats.

### ACL enforcement

Access control is enforced at two layers:

1. `SharedDrive.getChat()` (`sharedDrive.ts:170-175`) checks `canRead` before returning a ChatRoom instance. This gates
   all operations (read + write).
2. Mutating routes (POST, PATCH, DELETE at `routes/chat.ts:24-26, 55-56, 69-70`) additionally check `canWrite` before
   proceeding.
3. `markRead` (`routes/chat.ts:76-84`) only requires read access (via `getChat`), which is correct since read-state is a
   per-user annotation.

---

## Critical Issues

### 1. `deleteMessage` SSE event leaks pre-deletion content

`apps/api/src/lib/chat/chat.ts:220-225`

```typescript
this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_DELETED, {
    chatId: this.path.id,
    ownerId: this.path.ownerId,
    mountId: this.path.mountId,
    message: this.toMessage({...existing, deletedAt: now}),
}));
```

The database write at line 206 correctly sets `content: ''`, but the SSE event at line 224 is built from
`{...existing, deletedAt: now}` which retains the original `existing.content`. Any SSE consumer inspecting the message
payload receives the content of a "deleted" message.

Note that the whisper SSE fix at lines 116-118 was correctly applied for `postMessage`, but this same pattern was not
applied to `deleteMessage`. If the deleted message was a whisper, the SSE event includes the unfiltered whisper content,
whisperTo target, and full message body -- reversing the privacy protection added for posting.

**Impact:** Content of deleted messages (including whisper content) is visible in the SSE stream. Currently limited by
SSE architecture (only the chat owner's Home receives events), but the payload is objectively inconsistent with the
database state and violates the user's delete intent.

**Fix:** Build the payload with cleared content:

```typescript
message: this.toMessage({...existing, deletedAt: now, content: ''}),
```

### 2. `editMessage` SSE event leaks whisper content to all SSE subscribers

`apps/api/src/lib/chat/chat.ts:190-196`

```typescript
this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_EDITED, {
    chatId: this.path.id,
    ownerId: this.path.ownerId,
    mountId: this.path.mountId,
    message: updated,
}));
```

When a whisper message is edited, the SSE event includes the full updated message with content and whisperTo -- no
filtering is applied. The `postMessage` path was fixed (lines 116-118 strip content/whisperTo for whispers), but
`editMessage` was not updated with the same pattern.

**Impact:** Editing a whisper broadcasts its content via SSE. Same limited SSE architecture exposure as issue #1, but
the code defect is clear -- inconsistent treatment of whispers between post and edit paths.

**Fix:** Apply the same whisper filtering:

```typescript
const sseMessage = updated.type === 'whisper'
    ? {...updated, content: '', whisperTo: null}
    : updated;
this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_EDITED, {
    ...
        message
:
sseMessage,
}))
;
```

---

## Important Issues

### 3. `/reply` and `/invite` commands silently stored as regular messages

`apps/api/src/lib/chat/commands.ts:87-99` and `apps/api/src/lib/chat/chat.ts:53-73`

`parseCommand()` returns `{kind: 'reply', ...}` and `{kind: 'invite', ...}` for these commands. But the `switch` in
`postMessage()` (chat.ts:55-73) only handles `builtin-emote`, `emote`, `whisper`, and `error`. The `reply` and `invite`
cases fall through to `default: break`, causing the raw command text to be stored verbatim as a regular message visible
to all participants.

Example: if the frontend fails to intercept `/invite bob@example.com`, it reaches the backend and gets stored as a
plaintext message reading "/invite bob@example.com" -- leaking the intended private action.

The documentation (CHAT.md:92-93) says these are frontend-only commands, but the backend should reject them defensively.

**Impact:** Unintended data leakage (invite targets, reply content stored as public messages).

**Fix:** Add `case 'reply': case 'invite': throw new ApiError(400, 'This command is handled client-side');` to the
switch statement in `postMessage()`.

### 4. PATCH route has no content length limit

`apps/api/src/routes/chat.ts:62`

```typescript
body: t.Object({content: t.String()})
```

The POST route was fixed to include `maxLength: 50000` on the content field (line 39), but the PATCH route for editing
messages still uses bare `t.String()` with no length limit. A user can edit any of their messages to contain megabytes
of text, bloating the per-chat SQLite database.

**Impact:** DoS against chat participants. Database growth. Memory pressure on message fetch.

**Fix:** Change to `t.String({maxLength: 50000})` matching the POST route.

### 5. `whisperTo` dead-code comparison against userId

`apps/api/src/lib/chat/chat.ts:155`

```typescript
const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
```

`whisperTo` is always an email address (enforced by `validateEmailAddress` at line 77). The `msg.whisperTo === userId`
check compares an email against a UUID -- this will never be true. It is dead code that obscures the actual logic.

**Impact:** Code clarity. If someone changes the storage format to user IDs, they might assume this code already handles
it and miss updating other code paths.

**Fix:** Remove the `msg.whisperTo === userId` comparison.

### 6. `markRead` accepts any string as messageId without validation

`apps/api/src/lib/chat/chat.ts:230-244` and `apps/api/src/routes/chat.ts:77-84`

The `markRead` method stores the `messageId` directly in `read_state` without verifying the message exists. A client can
pass arbitrary strings (including message IDs from other chats or entirely fabricated IDs). This corrupts the read-state
tracking and can cause UI bugs in unread-badge calculations that compare IDs.

**Impact:** Potential read-state corruption. Minor data integrity concern.

**Fix:** Verify the message exists before storing:
`const msg = await this.db.select()...where(eq(schema.messages.id, messageId)).get(); if (!msg) return;`

### 7. Validation/parsing mismatch for `/me` prefix

`packages/lib/src/validation/command.ts:31` vs `apps/api/src/lib/chat/commands.ts:72`

The shared `validateCommand` function uses `trimmed.startsWith('/me')` (no trailing space), while the backend
`parseCommand` uses `trimmed.startsWith('/me ')` (with space). This means:

- `/me dances` -- validation: valid emote, parsing: valid emote. Correct.
- `/me` -- validation: caught as error ("requires action"). Correct.
- `/meet` -- validation: valid emote (matches `/me` prefix without space), parsing: does not match `/me ` prefix, falls
  through to error return. Mismatch.

The user experience: the frontend allows submission of `/meet`, the backend rejects it with a 400.

**Impact:** Poor UX for edge-case inputs. The backend correctly rejects, so no data corruption.

**Fix:** Change `validateCommand` to use `trimmed.startsWith('/me ')` with a trailing space, matching the backend.

### 8. Validation prefix matching for `/r` catches unrelated commands

`packages/lib/src/validation/command.ts:67`

```typescript
if (trimmed.startsWith('/reply') || trimmed.startsWith('/r')) {
```

`startsWith('/r')` matches `/r`, `/reply`, `/run`, `/read`, `/rtfm`, etc. Since built-in emotes and whisper commands are
checked first, the main risk is that any unknown `/r`-prefixed command (e.g., `/rtfm message`) is accepted as a valid
`reply` by the validator. The backend's `parseCommand` only checks `/reply ` and `/r ` (with spaces), so `/rtfm` would
not match and would fall through to the error return.

Same class of bug as issue #7 -- validation is more permissive than parsing.

**Impact:** Same as #7 -- false validation acceptance, backend 400.

**Fix:** Change to `trimmed.startsWith('/reply ') || trimmed.startsWith('/r ')` with trailing spaces, plus exact checks
for `/reply` and `/r` (no args).

### 9. `parseInt` on limit can produce NaN

`apps/api/src/routes/chat.ts:12`

```typescript
const limit = Math.min(Math.max(1, query.limit ? parseInt(query.limit) : 50), 200);
```

If `query.limit` is `"abc"`, then `parseInt("abc")` returns `NaN`. `Math.max(1, NaN)` returns `NaN`, and
`Math.min(NaN, 200)` returns `NaN`. The `NaN` propagates through to Drizzle's `.limit(NaN)`. SQLite behavior with a NaN
limit is undefined.

**Impact:** Unpredictable query behavior for malformed input.

**Fix:** Use a fallback:
`const parsed = parseInt(query.limit ?? ''); const limit = Math.min(Math.max(1, Number.isNaN(parsed) ? 50 : parsed), 200);`

---

## Minor Issues

### 10. `editMessage` does not prevent editing deleted messages

`apps/api/src/lib/chat/chat.ts:179-181`

```typescript
const existing = await this.db.select()...where(eq(schema.messages.id, messageId)).get();
if (!existing || existing.authorId !== userId) return null;
```

No check for `existing.deletedAt`. A user can edit a soft-deleted message, setting new content while `deletedAt` remains
set. The UI shows "This message was deleted" for messages with `deletedAt`, but the database now contains real content
in a "deleted" message.

**Fix:** Add `if (existing.deletedAt) return null;` after line 181.

### 11. `editMessage` allows editing built-in emotes into arbitrary text

`apps/api/src/lib/chat/chat.ts:179`

A built-in emote is stored as `$dance`, `$shrug`, etc. `formatEmoteForViewer` (commands.ts:108-119) looks up the `$`
prefix to render first/third person text. If a user edits a built-in emote to arbitrary content, the emote rendering
falls through to `${authorName} ${content}` (line 119), producing unexpected output.

Editing whispers is also allowed, which lets an author change the whisper content after the recipient has read it.

**Impact:** Semantic inconsistency. Low severity.

**Fix:** Restrict edits to `type === 'message'` only, or at minimum reject edits to built-in emotes (content starting
with `$`).

### 12. Pagination cursor uses non-unique `createdAt` timestamp

`apps/api/src/lib/chat/chat.ts:129-146`

Pagination uses `createdAt < beforeMsg.createdAt`. The `createdAt` column stores Unix timestamps at second granularity (
SQLite `unixepoch()`). Two messages posted within the same second share a cursor value. The JavaScript `new Date()`
provides millisecond precision, but Drizzle's `{mode: 'timestamp'}` stores as seconds. Fast sequential inserts within
the same second can cause skipped or duplicated messages at page boundaries.

**Fix:** Use a compound cursor: `WHERE (createdAt < ?) OR (createdAt = ? AND id < ?) ORDER BY createdAt DESC, id DESC`.

### 13. Empty string content allowed for regular messages

`apps/api/src/routes/chat.ts:39`

`t.String({maxLength: 50000})` accepts empty strings. Users can post completely blank messages.

**Fix:** Use `t.String({minLength: 1, maxLength: 50000})` for the POST body's `content` field. Do *not* add `minLength`
to PATCH -- the soft-delete flow sets `content: ''` internally.

### 14. `ChatRoom.create` is not atomic

`apps/api/src/lib/chat/chat.ts:32-35`

```typescript
static async create(drive: Drive, mountId: string, roomId: string): Promise<void> {
    await drive.touchFile(mountId, roomId, 'data.db', 'application/x-sqlite3');
    await drive.createFolder(mountId, roomId, 'media');
}
```

If `createFolder` fails after `touchFile` succeeds, the chat has `data.db` but no `media/` folder. The `init()` method
auto-creates `data.db` if missing, but there is no equivalent recovery for a missing `media/` folder.

**Impact:** Low -- the failure mode is rare and attachment uploads would error clearly.

**Fix:** Add `media/` recovery to `init()`, or wrap in a try/catch that cleans up `data.db` on failure.

### 15. Built-in emote names duplicated across four locations

The eight built-in emote names appear in:
- `apps/api/src/lib/chat/commands.ts:62-69` -- individual `if` checks in `parseCommand`
- `apps/api/src/lib/chat/commands.ts:8-41` -- `BUILT_IN_EMOTES` definitions
- `packages/lib/src/validation/command.ts:15` -- `builtinEmotes` array in `validateCommand`
- `packages/lib/src/core/chat/commands.ts` -- frontend `SLASH_COMMANDS` array

Adding a new emote requires updating all four files. The `BUILT_IN_EMOTES` keys could serve as the single source of
truth.

**Fix:** Extract the emote name list into a shared constant in `packages/lib/src/constants/` and import everywhere.

### 16. SSE route ignores `ownerId` URL parameter

`apps/api/src/routes/sse.ts:8-13`

The route is `/sse/:ownerId/events` but the handler uses `getHome(user.id)`, ignoring `params.ownerId`. A user can
request `/sse/anyone/events` and still only receive their own events. This means SSE events for shared resources (team
chats, shared drives) are never delivered to non-owner participants. The frontend works around this with
`refetchInterval: 5000` polling in chat.

**Impact:** Misleading API surface. Team/shared-resource SSE events are silently dropped.

**Fix:** Either use `params.ownerId` with authorization checks, or remove the parameter.

---

## Changes Since Previous Review (2026-03-18)

Several issues from the previous review have been fixed:

| Previous Issue                             | Status              | Detail                                                                                                       |
|--------------------------------------------|---------------------|--------------------------------------------------------------------------------------------------------------|
| #2: Clients can post `system` type         | **Fixed**           | `t.Literal('system')` removed from route body schema (line 40-44)                                            |
| #3: No message content length limit (POST) | **Fixed**           | `maxLength: 50000` added to POST content (line 39)                                                           |
| #5: No limit parameter validation/capping  | **Partially fixed** | `Math.min(Math.max(1, ...))` added (line 12), but NaN from non-numeric input still propagates (see issue #9) |
| #1: Whisper content in SSE (post path)     | **Fixed**           | Lines 116-118 strip content/whisperTo for whispers before SSE broadcast                                      |

Issues that remain unfixed from the previous review: delete SSE content leak (#6 previously, now #1), reply/invite
fallthrough (#4 previously, now #3), whisperTo dead code (#7 previously, now #5), markRead no validation (#8 previously,
now #6), validation/parsing mismatches (#9, #10 previously, now #7, #8), and all minor issues.

New issues found in this review: editMessage SSE whisper leak (#2), PATCH route missing maxLength (#4), parseInt NaN
propagation (#9).

---

## Strengths

**ACL enforcement is solid.** The two-layer approach (SharedDrive.getChat checks canRead; mutating routes additionally
check canWrite) is well-implemented and thoroughly tested. The test suite includes a full "Read-Only Access" section
that verifies all write operations are rejected for read-only users, including slash commands and whispers.

**Whisper validation is thorough.** The `postMessage` flow validates email format (`validateEmailAddress`), verifies the
user exists (`getUserByEmail`), and only then writes to the database. Failed whispers return 400/404 without storing any
data. Tests verify that failed whispers leave no trace in the database.

**Soft delete is correctly implemented.** Content is cleared in the database (`content: ''`), preventing recovery via
the REST API. Attachment files are cleaned up with proper error handling for already-deleted files.

**Whisper read-layer privacy is well-designed.** The `getMessagesForUser()` method correctly transforms whisper content
based on the viewer's identity, and the SSE broadcast for new whispers now strips sensitive data. Third parties see only
that a whisper occurred, not its content or target.

**Command system is clean.** The split between shared validation (frontend + backend) and backend-only parsing is
logical. The validation layer catches malformed input early, and the backend parsing handles the actual command
execution.

---

## Test Coverage Analysis

The test file (`apps/api/src/test/chat.test.ts`) contains 728 lines with comprehensive coverage across these areas:

| Area                  | Tests                                                                  | Verdict   |
|-----------------------|------------------------------------------------------------------------|-----------|
| Chat creation         | 3 tests: create, folder listing, internal structure                    | Good      |
| Embedded chat in docs | 1 test (partially commented out)                                       | Partial   |
| Message CRUD          | 6 tests: post, get, emote, edit, delete, reply                         | Good      |
| Whisper visibility    | 5 tests: author/recipient/third-party views                            | Excellent |
| Attachments           | 3 tests: upload+post, fetch, delete cascade                            | Good      |
| Slash commands        | 13 tests: built-in emotes, /me, /whisper aliases, validation           | Excellent |
| Read-only access      | 8 tests: read/post/edit/delete/slash/whisper blocked + upgrade         | Excellent |
| New emote commands    | 5 tests: allthethings/facepalm/shrug/flip + kaomoji display            | Good      |
| Backend validation    | 8 tests: non-email whisper, type field validation, delete by non-owner | Good      |
| Delete chat           | 1 test: create and delete                                              | Good      |

Command validation tests (`apps/api/src/test/command-validation.test.ts`): 168 lines covering valid commands, invalid
commands, and edge cases (whitespace, complex emails).

**Notable gaps:**

- Pagination edge cases (same-second messages, negative before, NaN limit)
- Editing deleted messages (should reject)
- Editing whisper/emote type messages
- Empty content message posting
- SSE event payload verification (content of whisper/delete events)
- Concurrent message posting (race conditions)
- Very large message content at the limit boundary
- markRead with non-existent messageId
- Reply/invite command fallthrough to message storage

---

## Relevant Files

| File                                           | Purpose                                        |
|------------------------------------------------|------------------------------------------------|
| `apps/api/src/lib/chat/chat.ts`                | ChatRoom class -- all business logic           |
| `apps/api/src/lib/chat/commands.ts`            | Slash command parsing + emote formatting       |
| `apps/api/src/lib/chat/schema.ts`              | Drizzle ORM schema                             |
| `apps/api/src/lib/chat/db-config.ts`           | Database config + migrations                   |
| `apps/api/src/lib/chat/sse-events.ts`          | SSE event builder                              |
| `apps/api/src/routes/chat.ts`                  | Route handlers                                 |
| `apps/api/src/lib/drive/drive.ts`              | Drive.getChat() (lines 206-214)                |
| `apps/api/src/lib/drive/sharedDrive.ts`        | SharedDrive.getChat() ACL gate (lines 170-175) |
| `apps/api/src/routes/sse.ts`                   | SSE subscription route                         |
| `packages/lib/src/types/chat.ts`               | Shared ChatMessage type                        |
| `packages/lib/src/validation/command.ts`       | Shared command validation                      |
| `apps/api/src/test/chat.test.ts`               | Integration tests                              |
| `apps/api/src/test/command-validation.test.ts` | Command validation unit tests                  |
| `docs/CHAT.md`                                 | Architecture documentation                     |
