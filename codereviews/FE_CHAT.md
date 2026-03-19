# FE Code Review: Chat

## Summary

The chat frontend follows Eigen conventions well: hooks live in `packages/lib/src/core/chat/hooks/`, shared UI in
`packages/ui/src/components/layout/chat/`, and the app shell uses `AppShell` with proper auth guards. The MUD-inspired
slash command system is cleanly split between frontend-only commands (help, time, inspect, invite, reply) and
backend-handled commands (emotes, whisper). However, there are several important issues: missing error feedback on
mutations, type safety bypasses with `as DrivePath` casts, hardcoded colors for whisper styling, a duplicate
`RoomMember` type, and XSS surface in the `inspect:` protocol.

## Critical Issues

### 1. Missing error feedback on `postMessage` and `uploadFile` mutations

**File**: `packages/lib/src/core/chat/hooks/use-chat-room.ts`, lines 69-141

The `handleSendMessage` function calls `postMessage.mutateAsync()` (line 112, 140) and `uploadFile.mutateAsync()` (line

77) without try/catch or `onError` callbacks. Per CLAUDE.md: "Every mutation needs error feedback."

If posting fails (network error, 403, 400 from invalid command), the user sees no feedback. The message just silently
disappears.

**Impact**: Users lose messages without knowing why. Particularly bad for `/reply` whispers (line 112) where the target
could fail validation server-side.

**Fix**: Wrap all `mutateAsync` calls in try/catch with `toast.error()`:

```typescript
try {
    await postMessage.mutateAsync({content: rawContent, attachments});
} catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to send message');
}
```

Also add `onError` to the `usePostMessage` mutation definition in `use-chat.ts`.

### 2. `usePostMessage` mutation has no `onError` callback

**File**: `packages/lib/src/core/chat/hooks/use-chat.ts`, lines 37-54

```typescript
export function usePostMessage(ownerId: string, mountId: string, chatId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body) => { ... },
        onSuccess: () => { ... },
        // No onError!
    });
}
```

Same issue for `useCreateChat` (lines 56-65) — no `onError` callback in the mutation. The callers in the app
(`_auth.index.tsx` and `chat-sidebar.tsx`) do wrap in try/catch, but the shared hook itself should provide error
feedback.

**Impact**: Any consumer of these hooks that forgets try/catch will silently swallow errors.

### 3. Hardcoded orange colors for whisper messages

**File**: `packages/ui/src/components/layout/chat/chat-message-list.tsx`, lines 205-207, 226

```typescript
"hover:bg-orange-50/50 dark:hover:bg-orange-950/30"
"bg-orange-50/30 dark:bg-orange-950/20"
"text-orange-500"
```

Per CLAUDE.md: "Use theme tokens, not hardcoded colors." These Tailwind color classes break if the app switches to a
non-default theme. The whisper styling should use semantic tokens or CSS custom properties.

**Impact**: Whisper messages may look wrong with custom themes and don't follow the design system.

**Fix**: Define whisper-specific CSS custom properties (e.g., `--whisper-bg`, `--whisper-text`) or use existing semantic
tokens like `bg-warning/10` if available.

## Pattern Violations

### 4. Multiple `as DrivePath` casts throughout the codebase

**Files**:

- `packages/lib/src/core/chat/hooks/use-chat.ts`, line 18: `(response.data || []) as DrivePath[]`
- `packages/lib/src/core/chat/hooks/use-chat-room.ts`, line 79: `(u as DrivePath).name`
- `packages/lib/src/core/chat/hooks/use-chat-room.ts`, line 133: `chatPath as DrivePath`
- `packages/lib/src/core/chat/hooks/use-chat-room.ts`, line 155: `chatPath as DrivePath | undefined`
- `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`, lines 21, 69, 73: `chat.chatPath as DrivePath`

Per CLAUDE.md: "Never use `as any` — fix the type at the source." While `as DrivePath` is safer than `as any`, these
casts indicate the Eden Treaty types are not flowing properly. The API response types should be inferred from the route
schemas.

**Impact**: Type safety is bypassed. If the API changes the response shape, these casts will silently mask the
mismatch.

**Fix**: Fix the route return types so Eden Treaty infers `DrivePath[]` correctly, or use a type guard.

### 5. `useChats` hook uses `useQuery` directly — this is correct per pattern

The hooks file in `packages/lib/src/core/chat/hooks/use-chat.ts` correctly places all `useQuery`/`useMutation` calls in
the shared hooks package. The app components (`_auth.index.tsx`, `chat-sidebar.tsx`) import from `@workspace/lib/chat`.
This follows the CLAUDE.md rule.

### 6. Duplicate `RoomMember` type definition

**Files**:

- `packages/lib/src/core/chat/hooks/use-chat-room.ts`, line 10-13
- `packages/ui/src/components/layout/chat/chat-utils.ts`, lines 13-16

The `RoomMember` type is defined identically in two places:

```typescript
export type RoomMember = { email: string; displayName: string; }
```

**Impact**: If one changes and the other doesn't, type mismatches will occur silently (they're structurally typed so
TypeScript won't catch the divergence until fields differ).

**Fix**: Define `RoomMember` once in `packages/lib/src/types/chat.ts` and import from there.

### 7. `interface` used in `__root.tsx` instead of `type`

**File**: `apps/chat/src/routes/__root.tsx`, line 7

```typescript
interface MyRouterContext { auth: AuthContextType }
```

Per CLAUDE.md: "Always `type` over `interface` — except when methods are needed." This should be `type MyRouterContext`.

**Impact**: Style violation only. No functional impact.

## Security Concerns

### 8. `inspect:` protocol in system messages is a local injection surface

**File**: `packages/ui/src/components/layout/chat/chat-message-list.tsx`, lines 167-173

System messages starting with `inspect:` are parsed and rendered as an `InspectCard`:

```typescript
if (message.content.startsWith('inspect:')) {
    const target = message.content.slice(8);
    return <InspectCard target={target} />;
}
```

The target comes from `addLocalMessage(`inspect:${local.target}`)` in `use-chat-room.ts` (line 103), which comes from
user input via the `/inspect` command. While the `validateEmailTarget` check in `commands.ts` validates the format
before `getLocalCommand` returns the target, this is defense-by-convention. If a code path ever sets a system message
with `inspect:` prefix without validation, the `InspectCard` would render with arbitrary content.

**Impact**: Low risk currently (local-only messages, React escaping). But the "magic prefix" protocol is fragile.

**Recommendation**: Use a structured message type instead of string prefix parsing. For example, store local messages as
`{ type: 'inspect', target: email }` rather than encoding as `"inspect:email"`.

### 9. No file type or size validation on attachment upload

**File**: `packages/lib/src/core/chat/hooks/use-chat-room.ts`, lines 73-80

Files are uploaded without any client-side validation:

```typescript
const uploaded = await Promise.all(
    files.map(file => uploadFile.mutateAsync({parentId: mediaFolder.id, file}))
);
```

While the server may enforce quotas via `enforceFileUpload`, there's no client-side feedback about file type
restrictions or size limits before upload.

**Impact**: Users can attempt to upload arbitrarily large files and only get feedback after the upload fails.

**Fix**: Add client-side size checks and optionally file type filtering in `ChatMessageInput` or `handleSendMessage`.

## Data Integrity

### 10. SSE handler handles events that are never emitted

**File**: `packages/lib/src/core/chat/sse-handlers.ts`, lines 19-22

```typescript
case SSEventType.CHAT_MEMBER_ENTERED:
case SSEventType.CHAT_MEMBER_LEFT:
case SSEventType.CHAT_TYPING:
    return true;
```

These event types are handled (returning `true` to indicate "handled") but they never trigger cache invalidation and are
never emitted by the backend.

**Impact**: Dead code. No functional harm but suggests incomplete presence/typing features.

### 11. `localIdCounter` is a module-level mutable variable

**File**: `packages/lib/src/core/chat/hooks/use-chat-room.ts`, line 15

```typescript
let localIdCounter = 0;
```

This counter is shared across all instances of `useChatRoom` in the same page. While functionally correct for generating
unique IDs, it means IDs are not deterministic across page loads, which could cause issues if local messages are ever
persisted or compared.

**Impact**: Minor. Local messages are ephemeral.

### 12. `allMessages` sorting by `createdAt` may reorder server messages

**File**: `packages/lib/src/core/chat/hooks/use-chat-room.ts`, lines 143-146

```typescript
const allMessages = useMemo(() => {
    return [...messages, ...localMessages].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
}, [messages, localMessages]);
```

Server messages are already sorted by the backend. Re-sorting after merging with local messages works, but
`new Date(a.createdAt).getTime()` is called on every render for every message. More importantly, if `createdAt` comes
as a string from the API (JSON serialization), `new Date(string)` parsing is fragile and locale-dependent for
non-ISO formats.

**Impact**: Low if `createdAt` is always ISO format or a numeric timestamp. But re-parsing dates on every useMemo
evaluation is wasteful for large message lists.

**Fix**: Parse dates once during the `useMessages` transform, not in the sort comparator.

### 13. `useChats` filters by `ownerId` client-side

**File**: `packages/lib/src/core/chat/hooks/use-chat.ts`, lines 13-23

```typescript
const all = (response.data || []) as DrivePath[];
return all.filter(p => p.ownerId === ownerId);
```

The API returns all chats matching the MIME type, and the client filters to only show those owned by the current
`ownerId`. This is inefficient — the server returns shared chats that are immediately discarded.

**Impact**: Wasted bandwidth and processing. Users with access to many shared chats will fetch unnecessary data.

**Fix**: Add an `ownerId` filter parameter to the server-side MIME query, or use a dedicated endpoint.

## Code Quality

### 14. `console.log` left in production code

**File**: `apps/chat/src/routes/_auth.index.tsx`, line 25

```typescript
console.log('redirecting to chat', chat);
```

**Impact**: Noise in browser console.

**Fix**: Remove.

### 15. `ChatMessageList` does not use `currentUserId` prop

**File**: `packages/ui/src/components/layout/chat/chat-message-list.tsx`, lines 17-26

The `currentUserId` prop is declared in the type but never used in the component body. It was likely intended for
message context menus (edit/delete own messages) or whisper display logic, but that logic lives in `useChatRoom`.

**Impact**: Dead prop. Minor confusion.

**Fix**: Remove or implement.

### 16. Auto-scroll uses `behavior: 'smooth'` which can miss new messages during rapid posting

**File**: `packages/ui/src/components/layout/chat/chat-message-list.tsx`, lines 136-138

```typescript
useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'});
}, [messages.length]);
```

Smooth scrolling during rapid message arrival can queue animations, causing the view to lag behind. Also, this
always auto-scrolls regardless of whether the user has scrolled up to read history.

**Impact**: Users reading old messages are forcibly scrolled to the bottom on every new message. Disrupts reading flow.

**Fix**: Track scroll position and only auto-scroll if the user is near the bottom:

```typescript
const isNearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 100;
if (isNearBottom) bottomRef.current?.scrollIntoView({behavior: 'smooth'});
```

### 17. `ChatMessageInput` textarea does not auto-resize

**File**: `packages/ui/src/components/layout/chat/chat-message-input.tsx`, lines 257-265

The textarea has `rows={1}` and `max-h-[120px]` but no auto-resize logic. As users type multi-line messages, they must
manually expand by pressing Enter, but Enter sends the message (Shift+Enter for newline). The textarea height never
adjusts to content.

**Impact**: Poor UX for multi-line messages.

**Fix**: Add auto-resize on input:

```typescript
const handleInput = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
};
```

### 18. `ChatSidebar` uses `window.location.href` for navigation

**File**: `apps/chat/src/components/chat/chat-sidebar.tsx`, line 44

```typescript
window.location.href = getChatRoomUrl(ownerId, mountId, newPath.id);
```

This causes a full page reload instead of using TanStack Router's client-side navigation (`useNavigate`). The
`_auth.index.tsx` correctly uses `navigate()` for the same operation (line 26-33).

**Impact**: Full page reload on chat creation from sidebar. Loses any in-memory state.

**Fix**: Use `useNavigate` from `@tanstack/react-router` instead of `window.location.href`.

### 19. `ChatView` does not handle `mobileColumn` switching

**File**: `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`, line 43

```typescript
<ColumnLayout>
    <Column id="messages" width="flex" toolbar={toolbar}>
```

`ColumnLayout` is used without a `mobileColumn` prop. Per LAYOUT.md, `mobileColumn` controls which column is visible on
mobile. Since this route only has one column, this is technically fine — but it means the sidebar-to-content transition
on mobile may not work as expected if more columns are added later.

### 20. `findLastWhisperFrom` only searches in `messages`, not `localMessages`

**File**: `packages/lib/src/core/chat/hooks/use-chat-room.ts`, lines 58-67

```typescript
const findLastWhisperFrom = useCallback(() => {
    if (lastWhisperFromRef.current) return lastWhisperFromRef.current;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'whisper' && msg.whisperTo === user?.email && msg.authorEmail) {
            return msg.authorEmail;
        }
    }
    return null;
}, [messages, user?.email]);
```

This only searches the server `messages` array, not `allMessages` (which includes local system messages). Since local
messages are always `type: 'system'`, this is actually correct — but the whisper check against `msg.whisperTo ===
user?.email` means it only finds whispers **received**, not whispers sent. This is the intended behavior for `/reply`.

## Architecture

### 21. No infinite scroll / load-more implementation

The `useMessages` hook only fetches the initial batch (default 50 messages). There is no load-more trigger in
`ChatMessageList` — users cannot scroll up to load older messages. The `before` query parameter is supported by the API
but never used by the frontend.

**Impact**: Users can only see the most recent 50 messages. In active chat rooms, older messages are completely
inaccessible.

**Fix**: Implement infinite scroll with a scroll-to-top trigger that calls `useMessages` with `beforeId` from the oldest
loaded message.

### 22. No edit/delete UI for own messages

The backend supports editing and deleting messages (PATCH/DELETE endpoints), and these are tested. But there is no UI
for users to edit or delete their own messages in `ChatMessageList`. The `currentUserId` prop is passed but unused
(issue #15).

**Impact**: Users must use external tools (API calls) to edit or delete their messages.

**Fix**: Add a message context menu (right-click or hover actions) for the message author showing edit/delete options.

### 23. No read state UI

The backend supports `markRead` and the `read_state` table tracks per-user read position. But the frontend never calls
the mark-read endpoint and there is no unread badge or indicator in the sidebar.

**Impact**: No unread message indicators anywhere in the UI.

**Fix**: Call `markRead` when the chat is focused/visible, and show unread counts in `ChatSidebar`.

## Positive Patterns

- **Shared hooks architecture**: All data hooks (`useMessages`, `usePostMessage`, `useChats`, `useCreateChat`) are
  correctly placed in `packages/lib/src/core/chat/hooks/`, not in the app. The app components only import from
  `@workspace/lib/chat`.
- **Clean SSE integration**: `handleChatSSEvent` follows the established pattern of invalidating query cache on SSE
  events, with exported `invalidateMessages` for reuse.
- **MUD-style command system**: The split between frontend-only commands (help, time, inspect, invite, reply) and
  backend commands (emotes, whisper) is well-designed. Frontend commands avoid unnecessary server round-trips while
  backend commands ensure persistence and privacy.
- **Proper auth guards**: The `_auth.tsx` route guard with `beforeLoad` redirect is correctly implemented.
- **Theme-aware non-whisper styling**: Regular messages use `text-foreground`, `text-muted-foreground`, `bg-muted/50`
  and other semantic tokens correctly. Only whisper messages use hardcoded orange.
- **Player suggestion component**: `ChatPlayerSuggest` merges room members with contact suggestions, providing a
  good UX for @ mentions.
- **Slash command autocomplete**: `ChatSlashSuggest` provides real-time command suggestions with keyboard navigation.

## Recommendations

| Priority | Issue  | Description                                                          |
|----------|--------|----------------------------------------------------------------------|
| **P0**   | #1, #2 | Add error feedback (toast.error) to all mutations                    |
| **P1**   | #3     | Replace hardcoded orange colors with theme tokens                    |
| **P1**   | #18    | Use TanStack Router navigation instead of `window.location.href`     |
| **P1**   | #21    | Implement infinite scroll for message history                        |
| **P1**   | #16    | Fix auto-scroll to respect user scroll position                      |
| **P2**   | #4     | Fix `as DrivePath` casts by improving API return types               |
| **P2**   | #6     | Deduplicate `RoomMember` type definition                             |
| **P2**   | #14    | Remove `console.log`                                                 |
| **P2**   | #15    | Remove unused `currentUserId` prop or implement edit/delete UI (#22) |
| **P2**   | #17    | Add textarea auto-resize                                             |
| **P2**   | #22    | Add edit/delete UI for own messages                                  |
| **P2**   | #23    | Implement read state tracking and unread indicators                  |
