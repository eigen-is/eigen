# Frontend Code Review: Chat App

## Summary

The Chat app (`apps/chat/`) is a standalone MUD-inspired messaging client backed by SSE for real-time updates and
polling as a fallback. It uses Drive-based ACL for permissions and stores each chat room as a `.eigenchat` Drive folder.
The app is relatively small (~8 source files in-app, plus shared hooks in `packages/lib/src/core/chat/`). The
architecture follows project conventions well, with data hooks centralized in `packages/lib`, proper auth guards, and
consistent use of `AppShell`/`EigenApp`.

## Architecture Compliance

**Passes:**

- Data hooks (`useChats`, `useMessages`, `usePostMessage`, `useCreateChat`, `useChatRoom`) are all in
  `packages/lib/src/core/chat/hooks/` -- no direct `useQuery`/`useMutation` in app code.
- SSE handler (`handleChatSSEvent`) is in `packages/lib/src/core/chat/sse-handlers.ts` and properly invalidates the
  query cache.
- Query keys follow the hierarchical pattern (`chatKeys.all`, `chatKeys.messages(...)`).
- Auth guard in `_auth.tsx` uses `beforeLoad` redirect pattern.
- Slash commands are split between frontend-only (local system messages) and backend-processed, matching the docs.
- Uses `EigenApp` provider stack and `AppShell` wrapper correctly.
- Shared types imported from `@workspace/lib/types/chat`.
- Media reference resolution uses `useFolderContent` to find the `media/` subfolder by name (correct per
  MEDIA-REFERENCES.md).

**Violations:**

- `DocsSidebar` and other Drive-based sidebar components in other apps use `interface` (e.g.,
  `apps/docs/src/components/docs/docs-sidebar.tsx:17`) instead of `type`. The chat sidebar
  (`apps/chat/src/components/chat/chat-sidebar.tsx:14`) correctly uses `type`. No violation here.
- `apps/chat/src/routes/__root.tsx:8` uses `interface MyRouterContext` -- minor style violation of the `type` over
  `interface` rule. This is a pattern shared across all apps however, likely inherited from TanStack Router examples.

## Issues Found

### Critical

None found.

### Important

1. **Polling fallback instead of SSE-driven updates for messages**
   (`packages/lib/src/core/chat/hooks/use-chat.ts:34`)

   `useMessages` uses `refetchInterval: 5000` (5-second polling) as its real-time mechanism. While the SSE handler
   (`handleChatSSEvent`) does exist and invalidates the message cache, the polling is still active as a fallback. This
   means:
    - Every open chat tab generates a GET request every 5 seconds regardless of SSE connectivity.
    - For rooms with many users, this creates unnecessary server load.
    - The SSE handler already handles `CHAT_MESSAGE_POSTED/EDITED/DELETED` events, so the polling is redundant when SSE
      is connected.

   **Recommendation:** Consider removing or significantly increasing the `refetchInterval` (e.g., 30s) and relying on
   SSE as the primary mechanism, or making the polling conditional on SSE connection status.

2. **`localIdCounter` is a module-level mutable variable**
   (`packages/lib/src/core/chat/hooks/use-chat-room.ts:15`)

   `let localIdCounter = 0` is used for generating IDs for local system messages. Since this is a module-level variable
   shared across all hook instances, it will never reset and will accumulate across navigation. While not a bug per se
   (IDs just need to be unique within the local session), it is an unconventional pattern. If the module is hot-reloaded
   during development, the counter resets to 0, potentially causing ID collisions with existing local messages.

3. **Missing error handling for chat creation in sidebar**
   (`apps/chat/src/components/chat/chat-sidebar.tsx:44`)

   After creating a chat, `window.location.href = getChatRoomUrl(...)` is used for navigation, causing a full page
   reload. The `_auth.index.tsx` route uses `navigate()` from TanStack Router for the same purpose. This inconsistency
   means the sidebar creates a jarring full-page reload while the index page uses client-side navigation.

   **File:** `apps/chat/src/components/chat/chat-sidebar.tsx:44`

4. **Local messages grow unboundedly**
   (`packages/lib/src/core/chat/hooks/use-chat-room.ts:29, 55-56`)

   `localMessages` state in `useChatRoom` accumulates system messages (help output, time, inspect, error messages) and
   never clears them. Over a long session with many slash commands, this array grows. The `allMessages` memo sorts the
   entire combined array on every render. While unlikely to cause visible performance issues in practice, it is worth
   noting.

5. **`getLocalCommand` does not handle the `error` kind**
   (`packages/lib/src/core/chat/hooks/use-chat-room.ts:88-137`)

   The `getLocalCommand` function can return `{kind: 'error', error: string}` (defined in `commands.ts:39`), but the
   `switch` statement in `handleSendMessage` does not have a case for `'error'`. When `validateCommand` returns an
   invalid result, `getLocalCommand` returns an error object, but the hook falls through to `postMessage.mutateAsync`,
   sending the raw command text as a regular message to the server.

   **File:** `packages/lib/src/core/chat/commands.ts:46-48` and `use-chat-room.ts:90`

### Minor

1. **`console.log` left in production code**
   (`apps/chat/src/routes/_auth.index.tsx:26`)

   `console.log('redirecting to chat', chat)` is a debug log that should be removed.

2. **Unnecessary `interface` instead of `type`**
   (`apps/chat/src/routes/__root.tsx:8`)

   `interface MyRouterContext` should be `type MyRouterContext = { auth: AuthContextType }` per the project's "type over
   interface" rule. This pattern appears in all apps' `__root.tsx` files.

3. **Redundant `beforeLoad` auth check in `_auth.index.tsx`**
   (`apps/chat/src/routes/_auth.index.tsx:91-98`)

   The `_auth.index.tsx` route has its own `beforeLoad` check for auth, but this is already handled by the parent
   `_auth.tsx` layout route. The nested check is redundant.

4. **Unused `redirect` import**
   (`apps/chat/src/routes/_auth.index.tsx:1`)

   `redirect` is imported from `@tanstack/react-router` and used in `beforeLoad`, but since the parent `_auth.tsx`
   already handles the redirect, the import in the child route is unnecessary duplication.

5. **SSE handler ignores `CHAT_TYPING` / `CHAT_MEMBER_ENTERED` / `CHAT_MEMBER_LEFT`**
   (`packages/lib/src/core/chat/sse-handlers.ts:19-21`)

   The SSE handler acknowledges these event types (returns `true`) but does not drive any UI updates. There is no typing
   indicator or presence indicator in the chat UI. The comment says "just UI updates" but no UI consumes these events.

6. **`useCallback` dependency includes unstable references**
   (`packages/lib/src/core/chat/hooks/use-chat-room.ts:141`)

   The `handleSendMessage` callback lists `ownerId, mountId, chatId` in its dependency array, but these come from the
   hook parameters (stable primitives). More concerning is that `chatContents`, `uploadFile`, and `postMessage` are
   objects that change reference on every render, causing `handleSendMessage` to be recreated frequently. This is not
   a performance bug since `ChatMessageInput` is not memoized, but it is worth noting if memoization is added later.

## Recommendations

1. **Handle the `error` kind from `getLocalCommand`** -- Add a `case 'error'` in the switch statement to display the
   validation error as a local message instead of silently sending the raw command text to the server.

2. **Remove or increase the 5s polling interval** -- With SSE already handling real-time updates, 5s polling is
   aggressive. Consider 30s or making it conditional on SSE connection status.

3. **Use TanStack Router navigation instead of `window.location.href`** in the sidebar's `handleCreateChat` to avoid
   full-page reloads.

4. **Remove the `console.log`** in `_auth.index.tsx:26`.

5. **Add typing indicators** -- The SSE infrastructure for `CHAT_TYPING` events already exists end-to-end. Consider
   implementing the UI component to surface this data.
