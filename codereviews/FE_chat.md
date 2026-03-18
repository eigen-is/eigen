# Frontend Review: Chat App

**Scope:** `apps/chat/`, `packages/lib/src/core/chat/`, `packages/ui/src/components/layout/chat/`
**Reviewed:** 2026-03-18

---

## Critical Issues

### 1. Missing `error` case in command dispatch causes malformed commands to be sent as messages

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:89-137`
**Previous review:** Identified as Important #5, upgraded to Critical after deeper analysis.

`getLocalCommand()` can return `{kind: 'error', error: string}` (line 47 of `commands.ts`) when
`validateCommand()` detects a malformed command -- e.g., `/me` without arguments, `/whisper` without
a target, `/invite` with an invalid email. The `switch` statement in `handleSendMessage` has no
`case 'error'` and no `default`. When the error kind is returned, execution falls through the entire
`if (local) { switch ... }` block and reaches line 140:

```
await postMessage.mutateAsync({content: rawContent, attachments});
```

This sends the raw malformed command text (e.g., `/me`, `/whisper badformat`) as a regular message
visible to all room participants. The validation exists specifically to prevent this, but its output
is silently ignored.

**Impact:** User-facing bug. Invalid slash commands produce visible garbage messages in the chat room
instead of showing the validation error. For whisper commands with malformed targets, this leaks the
intended private content as a public message.

**Fix:** Add a `case 'error'` (or `default`) that calls `addLocalMessage(local.error)` and returns.

---

### 2. No error handling in `handleSendMessage` -- unhandled Promise rejections

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:69-141`
**Status:** New finding.

The entire `handleSendMessage` async function has zero `try/catch` blocks. It calls three different
`.mutateAsync()` operations: `uploadFile` (line 77), `postMessage` (lines 112, 140), and
`updateACL` (line 133). Any of these can throw (network error, 403, quota exceeded, etc.).

Because `ChatMessageInput` calls `onSend` without awaiting it (the prop type is
`(rawContent: string, files?: File[]) => void`, not `Promise<void>`), every rejection becomes an
unhandled Promise rejection. The user sees no feedback -- the input is already cleared (line 54 of
`chat-message-input.tsx`), files are already removed, and focus is already reset.

**Impact:** Messages silently fail to send with no user feedback. File uploads can fail mid-batch
via `Promise.all` causing partial uploads with no recovery. The input is cleared so the user loses
their message text.

**Fix:** Wrap the body of `handleSendMessage` in try/catch, surface errors via `addLocalMessage()`
or `toast.error()`. Consider changing the `onSend` prop type to `Promise<void>` and awaiting it in
`ChatMessageInput` before clearing the input state, or use an optimistic pattern that restores input
content on failure.

---

## Important Issues

### 3. 5-second polling redundant with SSE -- only domain using `refetchInterval`

**File:** `packages/lib/src/core/chat/hooks/use-chat.ts:34`
**Previous review:** Identified as Important #1, analysis confirmed and refined.

`useMessages` sets `refetchInterval: 5000`. A codebase-wide search confirms this is the only hook
in the entire project that uses `refetchInterval`. Every other domain (Drive, Mail, Contacts,
Calendar) relies exclusively on SSE for real-time updates. The SSE handler
`handleChatSSEvent` already handles `CHAT_MESSAGE_POSTED`, `CHAT_MESSAGE_EDITED`, and
`CHAT_MESSAGE_DELETED` and invalidates the correct query key.

**Impact:** Each open chat tab generates a GET request every 5 seconds unconditionally. With N users
each with M open chat tabs, this creates N * M requests every 5 seconds. The polling also triggers
the auto-scroll `useEffect` in `ChatMessageList` on every refetch that changes the data reference
(even without new messages), which can cause unwanted scroll jumps when the user is reading history.

**Fix:** Remove `refetchInterval` entirely and rely on SSE, consistent with all other domains. If a
fallback is needed, increase to 60s or condition on SSE connection status via `useSSE` context.

---

### 4. `useChats` query key does not include `ownerId` -- stale data on user switch

**File:** `packages/lib/src/core/chat/hooks/use-chat.ts:14-15`
**Status:** New finding.

The query key is `[...driveKeys.mime('application-eigenchat'), 'own']` which resolves to
`['drive', 'mime', 'application-eigenchat', 'own']`. The `ownerId` parameter is used in the
`queryFn` (to call the API and to filter results) but is not part of the query key. If a different
user logs in within the same browser session (without a full page reload), TanStack Query will serve
the cached result from the previous user since the key is identical.

The client-side `filter(p => p.ownerId === ownerId)` on line 19 would return an empty array if the
API correctly scopes by auth session, but the query itself would not refetch until something
invalidates the mime query key.

**Impact:** Potential data leakage or stale sidebar list after user switch within the same tab.

**Fix:** Include `ownerId` in the query key: `[...driveKeys.mime('application-eigenchat'), 'own', ownerId]`.

---

### 5. `window.location.href` navigation in sidebar causes full page reload

**File:** `apps/chat/src/components/chat/chat-sidebar.tsx:44`
**Previous review:** Identified as Important #3, confirmed.

After creating a chat, the sidebar navigates with `window.location.href = getChatRoomUrl(...)`.
This destroys the entire React tree, all client state, and SSE connection. The index page
(`_auth.index.tsx:46-48`) uses TanStack Router `navigate()` for the exact same purpose. The sidebar
component does not have access to the router's `useNavigate` since it is rendered outside the route
tree (via `AppShell`'s sidebar render prop), which is likely why `window.location.href` was used.

**Impact:** Jarring full-page reload, loss of all client state, SSE reconnection delay.

**Fix:** Pass a navigation callback from the route component, or use `router.navigate()` from the
router instance (exported from `main.tsx`). Some apps solve this by passing `onNavigate` as a sidebar
prop.

---

### 6. File uploads silently dropped when media folder is missing

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:73-81`
**Status:** New finding.

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

### 7. Auto-scroll fires unconditionally on every message count change

**File:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:136-138`
**Status:** New finding.

```typescript
useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'});
}, [messages.length]);
```

This scrolls to the bottom whenever `messages.length` changes. Issues:

1. When the user is scrolled up reading history and a new message arrives (via SSE or polling), they
   are forcibly scrolled to the bottom, losing their place.
2. The initial render also triggers this, which is correct, but there is no distinction between
   "user sent a message" (should scroll) and "someone else sent a message while I'm reading old
   messages" (should not scroll, should show a "new messages" indicator instead).

**Impact:** Poor UX for users reading chat history in active rooms. Every new message interrupts
their scroll position.

**Fix:** Track whether the user is near the bottom (e.g., within 100px of the scroll end) and only
auto-scroll if they are. Show a "new messages" badge when new messages arrive while scrolled up.

---

## Minor Issues

### 8. `console.log` left in production code

**File:** `apps/chat/src/routes/_auth.index.tsx:25`
**Previous review:** Identified as Minor #1, confirmed.

`console.log('redirecting to chat', chat)` inside the `useEffect` auto-redirect. Debug logging.

**Fix:** Remove the line.

---

### 9. Duplicate `RoomMember` type definition

**File:** `packages/lib/src/core/chat/hooks/use-chat-room.ts:10-13` and
`packages/ui/src/components/layout/chat/chat-utils.ts:13-16`
**Status:** New finding.

Identical `RoomMember` type is defined in two locations:
- `packages/lib/src/core/chat/hooks/use-chat-room.ts:10` (exported)
- `packages/ui/src/components/layout/chat/chat-utils.ts:13` (exported, used by `ChatMessageInput` and `ChatPlayerSuggest`)

Both define `{ email: string; displayName: string; }`. This could diverge over time.

**Fix:** Define in one place (e.g., `packages/lib/src/types/chat.ts`) and import in both.

---

### 10. Redundant `beforeLoad` auth check in `_auth.index.tsx`

**File:** `apps/chat/src/routes/_auth.index.tsx:90-98`
**Previous review:** Identified as Minor #3, confirmed.

The `_auth.index.tsx` child route has its own `beforeLoad` auth redirect, but the parent
`_auth.tsx` layout route already handles this at lines 4-12. The child check is redundant. The
`redirect` import on line 1 exists only for this redundant check.

**Fix:** Remove the `beforeLoad` from the child route and the `redirect` import.

---

### 11. SSE handler swallows presence/typing events with no UI consumer

**File:** `packages/lib/src/core/chat/sse-handlers.ts:19-22`
**Previous review:** Identified as Minor #5, confirmed.

`CHAT_TYPING`, `CHAT_MEMBER_ENTERED`, and `CHAT_MEMBER_LEFT` events are matched and return `true`
(indicating the event was handled) but trigger no cache invalidation or UI update. The comment says
"just UI updates" but there is no typing indicator, no presence list, and no component consuming
these events. They are effectively dead code on the frontend.

**Impact:** No practical bug, but returning `true` prevents other handlers from processing these
events, and the comment is misleading.

**Fix:** Either implement typing/presence indicators, or change the comment to document that these
are intentionally swallowed pending future UI work.

---

### 12. Whisper messages use hardcoded `orange-50` which is invisible in dark mode

**File:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:205-207`
**Status:** New finding.

Whisper messages use `bg-orange-50/30` and `hover:bg-orange-50/50` -- Tailwind orange-50 is a very
light color (`#fff7ed`). In dark mode, this produces a nearly invisible off-white tint against the
dark background. The project uses `dark:` variant support (`@custom-variant dark` in globals.css),
but no `dark:` variants are applied anywhere in the chat message list component.

**Impact:** Whisper messages lose their visual distinction in dark mode.

**Fix:** Add dark mode variants, e.g., `dark:bg-orange-950/30 dark:hover:bg-orange-950/50`.

---

### 13. `interface` instead of `type` in `__root.tsx`

**File:** `apps/chat/src/routes/__root.tsx:7`
**Previous review:** Identified as Minor #2, confirmed.

`interface MyRouterContext` should be `type MyRouterContext = { auth: AuthContextType }` per the
project's coding standard. This pattern exists in all apps' `__root.tsx` files (inherited from
TanStack Router examples).

**Fix:** Change to `type`. Low priority since it appears across all apps.

---

### 14. `onSend` prop typed as synchronous but receives async handler

**File:** `packages/ui/src/components/layout/chat/chat-message-input.tsx:11`
**Status:** New finding.

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

### 15. Textarea does not auto-grow with content

**File:** `packages/ui/src/components/layout/chat/chat-message-input.tsx:264-265`
**Status:** New finding.

The textarea has `rows={1}` and `resize-none` with `min-h-[40px] max-h-[120px]`, but there is no
auto-resize logic. The textarea remains a single row regardless of content length. Multi-line input
(via Shift+Enter) works but the textarea does not expand to show the content -- the user must scroll
within a 40px-high box until the content exceeds `max-h-[120px]`.

**Impact:** Poor authoring experience for multi-line messages.

**Fix:** Add an `onChange` handler that sets `textarea.style.height = 'auto'` then
`textarea.style.height = textarea.scrollHeight + 'px'`, clamped to `max-h`.

---

## Observations

These are architectural notes and patterns worth documenting, not bugs.

### Architecture compliance

The chat app follows project conventions well:
- All data hooks (`useChats`, `useMessages`, `usePostMessage`, `useCreateChat`, `useChatRoom`) are
  in `packages/lib/src/core/chat/hooks/` -- no direct `useQuery`/`useMutation` in app code.
- SSE handler is correctly registered in `use-sse.ts` and invalidates the right query keys.
- Query keys follow the hierarchical pattern (`chatKeys.all`, `chatKeys.messages(...)`).
- Auth guard in `_auth.tsx` uses the standard `beforeLoad` redirect.
- Uses `EigenApp` provider stack and `AppShell` wrapper correctly.
- Shared types imported from `@workspace/lib/types/chat`.
- Slash commands are correctly split between frontend-only (local system messages) and
  backend-processed.

### `localIdCounter` module-level variable

`packages/lib/src/core/chat/hooks/use-chat-room.ts:15` uses `let localIdCounter = 0` as a
module-level mutable variable for generating local message IDs. This accumulates across navigation
and never resets. During HMR in development, the counter resets to 0, potentially causing ID
collisions with existing local messages in React's virtual DOM. Not a practical bug since local
messages are ephemeral and IDs only need session uniqueness, but worth noting as an unconventional
pattern. Previous review flagged this; assessment unchanged.

### Local messages grow without bound

`localMessages` state in `useChatRoom` (line 29) accumulates every system message from slash
commands and never clears. Over very long sessions this array grows, and the `allMessages` memo
(line 143) sorts the entire combined array on every change. Not a practical performance issue for
realistic usage. Previous review flagged this; assessment unchanged.

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
