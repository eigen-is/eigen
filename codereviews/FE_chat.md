# Frontend Review: Chat App

**Scope:** `apps/chat/`, `packages/lib/src/core/chat/`, `packages/ui/src/components/layout/chat/`
**Reviewed:** 2026-03-19

---

## Critical Issues

### 1. Missing `error` case in command dispatch causes malformed commands to be sent as messages

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:89-137`

`getLocalCommand()` can return `{kind: 'error', error: string}` (line 47 of `commands.ts`) when
`validateCommand()` detects a malformed command -- e.g., `/me` without arguments, `/whisper` without
a target, `/invite` with an invalid email. The `switch` statement in `handleSendMessage` has no
`case 'error'` and no `default`. When the error kind is returned, the switch body has no matching
case, so execution exits the `if (local)` block and reaches line 140:

```typescript
await postMessage.mutateAsync({content: rawContent, attachments});
```

This sends the raw malformed command text (e.g., `/me`, `/whisper badformat`) as a regular message
visible to all room participants. The validation exists specifically to prevent this, but its output
is silently ignored.

Separately, the `isUnknownCommand` check on line 83 only catches commands whose first word is not in
`SLASH_COMMANDS`. But a known command with bad arguments (like bare `/me`) passes `isUnknownCommand`
(returns false because `/me` is in the list), gets to `getLocalCommand` which returns `{kind: 'error'}`,
which the switch does not handle, and falls through to `postMessage`.

**Impact:** User-facing bug. Invalid slash commands produce visible garbage messages in the chat room
instead of showing the validation error. For whisper commands with malformed targets, this leaks the
intended private content as a public message.

**Fix:** Add a `case 'error'` (or `default`) that calls `addLocalMessage(local.error)` and returns.

---

### 2. No error handling in `handleSendMessage` -- unhandled Promise rejections

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:69-141`

The entire `handleSendMessage` async function has zero `try/catch` blocks. It calls three different
`.mutateAsync()` operations: `uploadFile` (line 77), `postMessage` (lines 112, 140), and
`updateACL` (line 133). Any of these can throw (network error, 403, quota exceeded, etc.).

Because `ChatMessageInput` calls `onSend` without awaiting it (the prop type is
`(rawContent: string, files?: File[]) => void`, not `Promise<void>` -- see
`chat-message-input.tsx:11`), every rejection becomes an unhandled Promise rejection. The user sees
no feedback -- the input is already cleared (line 54 of `chat-message-input.tsx`), files are already
removed, and focus is already reset.

Per the project rule "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with
`toast.error()`, or use the `onError` callback", and `usePostMessage` has no `onError` callback
either (`use-chat.ts:37-54`).

**Impact:** Messages silently fail to send with no user feedback. File uploads can fail mid-batch
via `Promise.all` causing partial uploads with no recovery. The input is cleared so the user loses
their message text.

**Fix:** Wrap the body of `handleSendMessage` in try/catch, surface errors via `addLocalMessage()`
or `toast.error()`. Consider changing the `onSend` prop type to `Promise<void>` and awaiting it in
`ChatMessageInput` before clearing the input state, or use an optimistic pattern that restores input
content on failure.

---

## Important Issues

### 3. `window.location.href` navigation in sidebar causes full page reload

**File:** `apps/chat/src/components/chat/chat-sidebar.tsx:44`

After creating a chat, the sidebar navigates with `window.location.href = getChatRoomUrl(...)`.
This destroys the entire React tree, all client state, and the SSE connection. The index page
(`_auth.index.tsx:46-48`) uses TanStack Router `navigate()` for the exact same purpose. The sidebar
component does not have access to the router's `useNavigate` since it is rendered outside the route
tree (via `AppShell`'s sidebar render prop), which is likely why `window.location.href` was used.

**Impact:** Jarring full-page reload, loss of all client state, SSE reconnection delay.

**Fix:** Pass a navigation callback from the route component, or use `router.navigate()` from the
router instance (exported from `main.tsx`). Some apps solve this by passing `onNavigate` as a sidebar
prop.

---

### 4. File uploads silently dropped when media folder is missing

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:73-81`

When a user attaches files, the code looks for a folder named `media` within the chat contents
(line 74). If no media folder exists (e.g., if the chat was created by an older version, or the
media folder was deleted), `mediaFolder` is undefined and the entire upload block is skipped. The
files are silently ignored -- no error message, no feedback. The message is still sent, just without
the attachments.

Similarly, if `chatPath` is null (line 73 guard), files are silently dropped.

**Impact:** Users select files, see them listed in the input, send the message, input clears, but
the attachments never appear. No indication that anything went wrong.

**Fix:** Show a local error message when the media folder is not found, or when `chatPath` is null
while files are present.

---

### 5. Auto-scroll fires unconditionally on every message count change

**File:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:136-138`

```typescript
useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'});
}, [messages.length]);
```

This scrolls to the bottom whenever `messages.length` changes. Issues:

1. When the user is scrolled up reading history and a new message arrives via SSE, they are forcibly
   scrolled to the bottom, losing their place.
2. The initial render also triggers this, which is correct, but there is no distinction between
   "user sent a message" (should scroll) and "someone else sent a message while I'm reading old
   messages" (should not scroll, should show a "new messages" indicator instead).

**Impact:** Poor UX for users reading chat history in active rooms. Every new message interrupts
their scroll position.

**Fix:** Track whether the user is near the bottom (e.g., within 100px of the scroll end) and only
auto-scroll if they are. Show a "new messages" badge when new messages arrive while scrolled up.

---

### 6. No read state tracking -- backend endpoint unused

**File:** `packages/lib/src/core/chat/hooks/use-chat.ts` (missing), `apps/api/src/routes/chat.ts`

The backend provides a `POST /chat/:ownerId/:mountId/:chatId/read` endpoint and a `read_state`
table in the schema, but no frontend hook calls this endpoint. There is no `useMarkAsRead` hook,
no unread badge on the sidebar, and no indication of which messages are new.

**Impact:** Users have no way to know which chats have unread messages. This is a functional gap
rather than a bug, but the backend infrastructure exists and is simply not wired up.

**Fix:** Add a `useMarkAsRead` mutation hook that calls the read endpoint when a chat is opened.
Add unread counts to the sidebar chat list items.

---

### 7. No pagination support -- all messages loaded at once

**File:** `packages/lib/src/core/chat/hooks/use-chat.ts:25-35`

The backend supports cursor-based pagination via `before` and `limit` query parameters
(see `apps/api/src/routes/chat.ts:12-17`), defaulting to 50 messages. The frontend `useMessages`
hook calls `messages.get()` with no parameters, so it always receives the latest 50 messages only.
There is no "load more" / infinite scroll mechanism to retrieve older messages.

**Impact:** Chat history beyond the last 50 messages is inaccessible. Users cannot scroll up to
read older messages. For long-lived chat rooms this is a significant data loss from the user's
perspective.

**Fix:** Switch to `useInfiniteQuery` with the `before` cursor, or add a "load earlier messages"
button that fetches the next page.

---

## Minor Issues

### 8. `console.log` left in production code

**File:** `apps/chat/src/routes/_auth.index.tsx:25`

`console.log('redirecting to chat', chat)` inside the `useEffect` auto-redirect. Debug logging.

**Fix:** Remove the line.

---

### 9. Duplicate `RoomMember` type definition

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:10-13` and
`packages/ui/src/components/layout/chat/chat-utils.ts:13-16`

Identical `RoomMember` type is defined in two locations:
- `packages/lib/src/core/chat/hooks/use-chat-room.ts:10` (exported)
- `packages/ui/src/components/layout/chat/chat-utils.ts:13` (exported, used by `ChatMessageInput` and `ChatPlayerSuggest`)

Both define `{ email: string; displayName: string; }`. These can diverge independently.

**Fix:** Define in one place (e.g., `packages/lib/src/types/chat.ts`) and import in both.

---

### 10. Redundant `beforeLoad` auth check in `_auth.index.tsx`

**File:** `apps/chat/src/routes/_auth.index.tsx:90-98`

The `_auth.index.tsx` child route has its own `beforeLoad` auth redirect, but the parent
`_auth.tsx` layout route already handles this at lines 4-12. The child check is redundant. The
`redirect` import on line 1 exists only for this redundant check.

**Fix:** Remove the `beforeLoad` from the child route and the `redirect` import.

---

### 11. SSE handler swallows presence/typing events with no UI consumer

**File:** `packages/lib/src/core/chat/sse-handlers.ts:19-22`

`CHAT_TYPING`, `CHAT_MEMBER_ENTERED`, and `CHAT_MEMBER_LEFT` events are matched and return `true`
(indicating the event was handled) but trigger no cache invalidation or UI update. The comment says
"just UI updates" but there is no typing indicator, no presence list, and no component consuming
these events. They are effectively dead code on the frontend.

**Impact:** No practical bug, but returning `true` prevents other handlers from processing these
events, and the comment is misleading.

**Fix:** Either implement typing/presence indicators, or change the comment to document that these
are intentionally swallowed pending future UI work.

---

### 12. `interface` instead of `type` in `__root.tsx`

**File:** `apps/chat/src/routes/__root.tsx:7`

`interface MyRouterContext` should be `type MyRouterContext = { auth: AuthContextType }` per the
project's coding standard ("Always `type` over `interface` -- except when methods are needed").
This pattern exists in all apps' `__root.tsx` files (inherited from TanStack Router examples).

**Fix:** Change to `type`. Low priority since it appears across all apps.

---

### 13. `onSend` prop typed as synchronous but receives async handler

**File:** `packages/ui/src/components/layout/chat/chat-message-input.tsx:11`

The prop is `onSend: (rawContent: string, files?: File[]) => void` but the actual handler
(`handleSendMessage` in `use-chat-room.ts:69`) is `async` and returns `Promise<void>`. The
`handleSend` function in `ChatMessageInput` (line 53) calls `onSend()` without `await`, then
immediately clears input state on lines 54-55.

This means the input is cleared optimistically before the network request completes. If the request
fails (and once error handling is added per Critical #2), the user has already lost their typed
message.

**Impact:** No visible bug today (since errors are unhandled anyway), but becomes important once
error handling is added.

**Fix:** Change prop type to `(rawContent: string, files?: File[]) => void | Promise<void>` and
consider awaiting before clearing, or implement optimistic state restoration.

---

### 14. Textarea does not auto-grow with content

**File:** `packages/ui/src/components/layout/chat/chat-message-input.tsx:264-265`

The textarea has `rows={1}` and `resize-none` with `min-h-[40px] max-h-[120px]`, but there is no
auto-resize logic. The textarea remains a single row regardless of content length. Multi-line input
(via Shift+Enter) works but the textarea does not expand to show the content -- the user must scroll
within a 40px-high box until the content exceeds `max-h-[120px]`.

**Impact:** Poor authoring experience for multi-line messages.

**Fix:** Add an `onChange` handler that sets `textarea.style.height = 'auto'` then
`textarea.style.height = textarea.scrollHeight + 'px'`, clamped to `max-h`.

---

### 15. `currentUserId` prop accepted but unused in `ChatMessageList`

**File:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:20`

The `ChatMessageListProps` type declares `currentUserId: string` and the prop is passed from
`_auth.$ownerId.$mountId.$chatId.tsx:49`, but the component body never references it. This is
likely a remnant from planned features (e.g., right-aligning own messages, showing edit/delete
controls for own messages).

**Fix:** Either implement the feature that needs it, or remove the prop from the type and the
call site.

---

### 16. `data: any` in `DriveCreateChatProps` callback

**File:** `packages/ui/src/components/layout/drive/drive-create-chat.tsx:13`

```typescript
onAfterAction?: (actionType: string, data: any) => void;
```

Per the project rule "Never use `as any` -- fix the type at the source", this `data: any` parameter
should be typed. The call site passes `{name: fileName}` (line 41).

**Fix:** Type as `(actionType: string, data: { name: string }) => void` or use a discriminated
union if multiple action types are planned.

---

## Observations

These are architectural notes and patterns worth documenting, not bugs.

### Architecture compliance

The chat app follows project conventions well:
- All data hooks (`useChats`, `useMessages`, `usePostMessage`, `useCreateChat`, `useChatRoom`) are
  in `packages/lib/src/core/chat/hooks/` -- no direct `useQuery`/`useMutation` in app code.
- SSE handler is correctly registered and invalidates the right query keys for message events.
- Query keys follow the hierarchical pattern (`chatKeys.all`, `chatKeys.messages(...)`).
- `chatKeys.messages` includes `ownerId`, `mountId`, and `chatId` -- correctly scoped.
- `useChats` query key includes `ownerId` via `driveKeys.mime(ownerId, ...)` -- correctly scoped.
- Auth guard in `_auth.tsx` uses the standard `beforeLoad` redirect.
- Uses `EigenApp` provider stack and `AppShell` wrapper correctly.
- Shared types imported from `@workspace/lib/types/chat`.
- Slash commands are correctly split between frontend-only (local system messages) and
  backend-processed (emotes, whispers sent via POST).
- Error handling in `ChatSidebar.handleCreateChat` and `ChatIndex.handleCreateChat` both use
  try/catch with `toast.error()` -- compliant with project rules.
- Whisper messages now have proper dark mode variants (`dark:bg-orange-950/20`).
- Polling (`refetchInterval`) has been removed; chat relies purely on SSE, consistent with all other
  domains.

### Strengths

- **Command system**: The slash command architecture is well-designed with clean separation between
  `validateCommand` (shared validation), `getLocalCommand` (frontend-only dispatch),
  `isUnknownCommand` (guard), and the backend command processor. The help text is maintained in one
  place (`COMMANDS_HELP`) and rendered both in the help command output and the slash suggest dropdown.
- **@ mention suggest**: The player suggestion system handles edge cases well -- only triggers after
  whitespace/start-of-line, merges room members with contact suggestions, deduplicates, and handles
  keyboard navigation (arrow keys, Tab, Enter, Escape) cleanly.
- **Slash suggest**: Similarly well-implemented with deduplicated results, keyboard navigation, and
  correct handling of commands that need arguments (adds trailing space) vs those that don't.
- **Attachment preview**: Inline image thumbnails in attachment chips with click-to-preview
  integration via `usePreview`.
- **Message grouping**: The `isSameAuthorAndClose` function provides clean message grouping within
  5-minute windows, hiding redundant avatars and headers for consecutive messages from the same
  author.
- **Rich content rendering**: `RichContent` component replaces inline email addresses with avatar +
  name links using `EMAIL_FIND_REGEX` -- elegant inline enrichment.
- **Inspect card**: The `/inspect` command renders a rich contact card with avatar, company, job
  title, and phone number pulled from the user's contacts database. Nice MUD-inspired touch.

### `localIdCounter` module-level variable

`packages/lib/src/core/chat/hooks/use-chat-room.ts:15` uses `let localIdCounter = 0` as a
module-level mutable variable for generating local message IDs. This accumulates across navigation
and never resets. During HMR in development, the counter resets to 0, potentially causing ID
collisions with existing local messages in React's virtual DOM. Not a practical bug since local
messages are ephemeral and IDs only need session uniqueness.

### Local messages grow without bound

`localMessages` state in `useChatRoom` (line 29) accumulates every system message from slash
commands and never clears. Over very long sessions this array grows, and the `allMessages` memo
(line 143) sorts the entire combined array on every change. Not a practical performance issue for
realistic usage, but the state persists within the hook's lifecycle (i.e., while the chat room
is mounted).

### No `mobileColumn`/`onBack` in `ColumnLayout` -- single-column layout

`apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx:43-44` uses `ColumnLayout` with a single
`Column`. The `mobileColumn` prop is not set and `onBack` is not provided. This means on mobile
there is no back navigation to the chat list -- the user must use the sidebar. This is consistent
with the current single-column design (the sidebar serves as the list) but differs from other apps
that use two-column layouts with mobile switching.

### `AttachmentChip` calls `useFolderContent` per-chip

Each `AttachmentChip` component independently calls `useFolderContent(ownerId, mountId,
mediaFolderId)` (line 35 of `chat-message-list.tsx`). When a message has multiple attachments,
this results in multiple hook instances, though TanStack Query deduplicates them by query key so
only one network request occurs. Still, this pattern could be improved by lifting the media contents
lookup to the message list level and passing the resolved data down.

### `useChats` filters client-side for own chats

`useChats` (line 17-19 of `use-chat.ts`) fetches all eigenchat items visible to the user (including
shared chats) and filters client-side with `p.ownerId === ownerId`. This means shared/team chats
are fetched but discarded. The sidebar only shows the user's own chats. This may be intentional
(simplicity over optimization) but means the chat app currently has no way to access team chats or
chats shared by others, except by direct URL.

---

## Files Reviewed

| File                                                             | Purpose                                                                            |
|------------------------------------------------------------------|------------------------------------------------------------------------------------|
| `apps/chat/src/main.tsx`                                         | App entry point, router setup                                                      |
| `apps/chat/src/routes/__root.tsx`                                | Root layout with AppShell + sidebar                                                |
| `apps/chat/src/routes/_auth.tsx`                                 | Auth guard layout                                                                  |
| `apps/chat/src/routes/_auth.index.tsx`                           | Index page with auto-redirect + create chat                                        |
| `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`       | Chat room view                                                                     |
| `apps/chat/src/routes/login.tsx`                                 | Login route                                                                        |
| `apps/chat/src/components/chat/chat-sidebar.tsx`                 | Sidebar with chat list + create button                                             |
| `apps/chat/src/routeTree.gen.ts`                                 | Generated route tree                                                               |
| `apps/chat/css/globals.css`                                      | App-specific CSS (2 classes)                                                       |
| `packages/lib/src/core/chat/hooks/use-chat.ts`                   | `useChats`, `useMessages`, `usePostMessage`, `useCreateChat`, `invalidateMessages` |
| `packages/lib/src/core/chat/hooks/use-chat-room.ts`              | `useChatRoom` -- room state, command dispatch, message send                        |
| `packages/lib/src/core/chat/commands.ts`                         | `getLocalCommand`, `isUnknownCommand`, `COMMANDS_HELP`, `SLASH_COMMANDS`           |
| `packages/lib/src/core/chat/sse-handlers.ts`                     | `handleChatSSEvent`                                                                |
| `packages/lib/src/core/chat/index.ts`                            | Barrel export                                                                      |
| `packages/lib/src/core/chat/hooks/index.ts`                      | Barrel export                                                                      |
| `packages/lib/src/types/chat.ts`                                 | `ChatMessage`, `ChatReadState` types                                               |
| `packages/lib/src/validation/command.ts`                         | `validateCommand`                                                                  |
| `packages/lib/src/validation/email.ts`                           | `validateEmailTarget`, `EMAIL_REGEX`                                               |
| `packages/ui/src/components/layout/chat/chat-message-list.tsx`   | Message rendering, grouping, attachments, inspect cards                            |
| `packages/ui/src/components/layout/chat/chat-message-input.tsx`  | Input with file attach, @ mention suggest, slash suggest                           |
| `packages/ui/src/components/layout/chat/chat-slash-suggest.tsx`  | Slash command autocomplete dropdown                                                |
| `packages/ui/src/components/layout/chat/chat-player-suggest.tsx` | @ mention autocomplete dropdown                                                    |
| `packages/ui/src/components/layout/chat/chat-utils.ts`           | `getAtSuggestQuery`, `RoomMember` type                                             |
| `packages/ui/src/components/layout/chat/index.ts`                | Barrel export                                                                      |
| `packages/ui/src/components/layout/drive/drive-create-chat.tsx`  | Drive-integrated chat creation dialog                                              |
