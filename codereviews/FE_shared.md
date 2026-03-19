# Frontend Review: Shared Packages (packages/lib + packages/ui)

**Scope:** `packages/lib/src/` (API client, hooks, types, validation, constants), `packages/ui/src/components/layout/` (
app shell, providers, sidebar, drive, labels, etc.), `packages/ui/src/hooks/` (list selection, keyboard nav, drag-drop)
**Reviewed:** 2026-03-19

---

## Architecture Overview

### API Client (`packages/lib/src/core/api.ts`)

Eden Treaty wraps the Elysia `app` type to produce a fully type-safe client. A single `treaty<app>()` instance is
created at module scope with `credentials: 'include'` and then destructured into per-domain accessors (`driveApi`,
`mailApi`, `contactsApi`, etc.). URL builders for downloads, previews, WebSocket endpoints, and cross-app navigation are
co-located here. The pattern `driveApi({ownerId})({mountId}).folder({pathId}).get()` propagates path parameter types
from route definitions.

### Query Key Factories

Each domain defines a `keys` object (e.g., `driveKeys`, `emailKeys`, `calendarKeys`) following the hierarchical pattern
from the TanStack Query docs. Keys are built by spreading parent key arrays, enabling prefix-based invalidation. Drive
keys include `ownerId` at every level via `owner(ownerId)`. Mail, contacts, and labels omit ownerId since they are
inherently single-user. Calendar keys partially include ownerId (`calendarEvents`) but omit it from `calendarList`,
`eventRange`, and `sharedCalendars`.

### SSE System

`useSSE` (in `packages/lib/src/core/sse/hooks/use-sse.ts`) opens an `EventSource` to `/sse/{userId}/events`. Incoming
events are parsed and dispatched through seven domain handlers (`handleDriveSSEvent`, `handleMailSSEvent`,
`handleContactsSSEvent`, `handleChatSSEvent`, `handleCalendarSSEvent`, `handleSpaceSSEvent`, `handleTeamSSEvent`). Each
handler checks the event type prefix, then calls domain-specific invalidation functions that are co-located with the
query hooks. Notification events (those with a `body` field) are forwarded to the `SSEProvider` which shows Sonner
toasts.

### Hook Architecture

All data hooks live in `packages/lib/src/core/[domain]/hooks/`. Apps never call `useQuery`/`useMutation` directly. Each
hook file exports both the hooks and the invalidation functions, which are shared between `onSuccess` callbacks and SSE
handlers. Mail, contacts, and label hooks obtain `ownerId` internally via `useAuth()`. Drive, calendar, chat, and team
hooks receive `ownerId` as a parameter, supporting both personal and team contexts.

### UI Component Library

`packages/ui/src/components/layout/` provides the shared application shell:

- **`EigenApp`**: Root provider stack (HotkeysProvider > TooltipProvider > QueryClient > Auth > Theme > SSE > Upload >
  Preview > Toaster)
- **`AppShell`**: Per-app wrapper with Topbar + SidebarContainer + main content area
- **`ColumnLayout` / `Column`**: Responsive multi-column layout with mobile column switching
- **`DriveLayout`**: Reusable file browser orchestrating list, detail, and dialogs
- **List hooks** (`useListSelection`, `useKeyboardListNavigation`, `useListDrag`, `useListDropTarget`): Composable,
  generic selection/navigation/DnD

### Layout System

`ColumnLayout` accepts a `mobileColumn` prop. On mobile, only the column matching `mobileColumn` renders; on desktop,
all columns render side-by-side. `Column` accepts `width` (CSS value or `"flex"`) and an optional `toolbar` (h-12 bar
above content). Back navigation is provided via `onBack` prop which shows an arrow button on mobile.

---

## Critical Issues

### 1. `useCreateChat` passes `mountId` where `ownerId` is expected

`packages/lib/src/core/chat/hooks/use-chat.ts:63`

```typescript
onSuccess: (_data, variables) => invalidateItemCreated(queryClient, mountId, variables.parentId, 'DRIVE_MIME_CHAT'),
```

The `invalidateItemCreated` function signature is:

```typescript
function invalidateItemCreated(queryClient: QueryClient, ownerId: string, mountId: string, parentId: string | null | undefined, mimeType?: string | null): void
```

The call passes `mountId` as the second argument (the `ownerId` position) and omits `mountId` entirely. This means after
creating a chat room, the folder invalidation targets the wrong owner key (`['drive', 'default', 'folder', ...]` instead
of `['drive', '<actual-ownerId>', 'folder', ...]`). The folder contents will not refresh until staleTime expires or the
user navigates away. The fix is to pass `ownerId` as the second argument:

```typescript
onSuccess: (_data, variables) => invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_CHAT'),
```

### 2. UUID validation regex accepts non-hex characters

`packages/lib/src/types/owner.ts:24`

```typescript
const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
```

The character class includes `A-Z` instead of `A-F`. With the `i` flag, the intended hex range `a-f` / `A-F` becomes
unnecessary to specify both cases, but the uppercase range `A-Z` matches all 26 letters, not just the 6 hex digits. A
string like `00000000000000000000000000000zzz` passes this regex. The regex should be:

```typescript
const uuidRegex = /^[0-9a-f]{32}$/i;
```

### 3. Calendar query keys omit `ownerId`, causing cross-context cache collisions

`packages/lib/src/core/calendar/hooks/use-calendar.ts:14-22`

```typescript
export const calendarKeys = {
    all: ['calendar'] as const,
    calendars: () => [...calendarKeys.all, 'calendars'] as const,
    calendarList: () => [...calendarKeys.calendars(), 'list'] as const,
    events: () => [...calendarKeys.all, 'events'] as const,
    eventRange: (from: number, to: number) => [...calendarKeys.events(), {from, to}] as const,
    sharedCalendars: () => [...calendarKeys.all, 'shared'] as const,
    // calendarEvents includes ownerId -- this one is correct
    calendarEvents: (ownerId: string, calendarId: string, from: number, to: number) => [...],
};
```

`calendarList`, `eventRange`, and `sharedCalendars` do not include `ownerId`. The `useCalendars` and `useEvents` hooks
receive `ownerId` as a parameter and pass it to the API, but the cache keys are global. When a user views their personal
calendar and then switches to a team calendar, the same key `['calendar', 'calendars', 'list']` is used for both,
serving stale data from the wrong context.

Similarly, SSE invalidation functions like `invalidateCalendarCreated` and `invalidateEventCreated` invalidate all
calendar keys globally, which is overly broad and could cause unnecessary refetches across unrelated calendar contexts.

Fix: Add `ownerId` to `calendarList`, `eventRange`, and `sharedCalendars`, similar to how `driveKeys` includes `ownerId`
via `owner()`.

---

## Important Issues

### 4. `parseOwnerId` uses `if`/`if` instead of `if`/`else if`

`packages/lib/src/types/owner.ts:14-19`

```typescript
if (ownerId.startsWith('team_')) {
    id = ownerId.slice(5);
    type = 'team';
}
if (ownerId.startsWith('org_')) {
    id = ownerId.slice(4);
    type = 'org';
}
```

Both conditions are checked independently. While no real string starts with both `team_` and `org_`, this is still a
logic error: after matching `team_`, the function performs an unnecessary `startsWith('org_')` check. More importantly,
it means a hypothetical input like a malformed ID could behave unexpectedly. The second `if` should be `else if`.

### 5. `UploadProvider.contextValue` is not memoized

`packages/ui/src/components/layout/upload-provider/upload-provider.tsx:33-92`

The `contextValue` object is created inline every render. Since it is a new object reference each time, every consumer
of `useUpload()` re-renders whenever the `UploadProvider` re-renders (which happens on every upload state change).
Additionally, `removeUpload` captures `uploads` from the render closure, which could be stale when called
asynchronously.

Fix: Extract `createUpload` and `removeUpload` with `useCallback` (using functional state updates) and wrap
`contextValue` in `useMemo`.

### 6. `ShadowContent` uses `as any` to store shadow root reference

`packages/ui/src/components/layout/shadow-content.tsx:32-42`

```typescript
if ((hostElement as any)._shadowRoot) {
    shadowRoot = (hostElement as any)._shadowRoot;
} else {
    shadowRoot = hostElement.attachShadow({mode: "closed", clonable: true});
    (hostElement as any)._shadowRoot = shadowRoot;
}
```

Three `as any` casts are used to store the shadow root on the DOM element (necessary because closed-mode shadow roots
are not accessible via `element.shadowRoot`). This is inherently DOM manipulation that TypeScript cannot model cleanly.
A `WeakMap<HTMLElement, ShadowRoot>` would be type-safe:

```typescript
const shadowRoots = new WeakMap<HTMLElement, ShadowRoot>();
// ...
const existing = shadowRoots.get(hostElement);
```

### 7. `useSSE` `isConnected` is a stale snapshot, not reactive state

`packages/lib/src/core/sse/hooks/use-sse.ts:61-63`

```typescript
return {
    isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
};
```

This is computed from a ref at render time and never triggers re-renders when the connection state changes. Any
component reading `isConnected` gets the value from the last render, not the current connection state. Should use
`useState` updated via `eventSource.onopen` / `eventSource.onerror` handlers.

### 8. Module-level singleton `QueryClient`

`packages/ui/src/components/layout/app/eigen-app.tsx:21`

```typescript
const queryClient = new QueryClient();
```

Created at module scope rather than inside the component. All `EigenApp` instances (if any) share the same cache, and
the instance persists across hot module replacement during development. Standard practice is
`const [queryClient] = useState(() => new QueryClient())` inside the component. In practice this works since there is
one EigenApp per app, but it could cause issues in test environments or if HMR re-imports the module.

### 9. `UserAvatar`, `UserItem`, and `UserName` have triplicated user resolution logic

`packages/ui/src/components/layout/user-avatar.tsx:33-44`
`packages/ui/src/components/layout/user-item.tsx:35-48`
`packages/ui/src/components/layout/user-name.tsx:32-43`

All three components independently call:

1. `useContacts()` -- fetches the entire contact list
2. `usePublicUser(userId || email || '')` -- public user lookup
3. `usePublicConfig()` -- org configuration
4. `usePeopleTeams(org?.orgId)` -- team list for name resolution

Then they compute `displayName` and `resolvedEmail` with identical fallback chains. In a chat message list with 20
messages, each `UserAvatar` triggers these 4 queries (TanStack Query deduplicates, but the logic is still repeated). A
change to the display name resolution must be made in three places.

Fix: Extract a `useResolvedUser(emailOrId)` hook returning `{displayName, avatarSrc, resolvedEmail, isLoading}`.

### 10. Error handling inconsistency across query hooks

Some hooks check `response.error` and throw:

- `useFolderContent`, `useCreateCalendar`, `useUpdateCalendar`, `useDeleteCalendar`, `useCreateEvent`, `useUpdateEvent`,
  `useDeleteEvent`, `useAddContact`, `useUpdateContact`, `useDeleteContact`

Others silently return empty/null data on failure:

- `useMounts` returns `[]`, `useRootFolder` returns `null`, `useMailboxes` returns `[]`, `useCalendars` casts and
  returns `[]`, `useHomeSize` returns `null`, `usePathInfo` returns `null`, `useCheckReadPermission` returns
  `{canRead: false}`

When an API call fails, the latter group reports `isSuccess: true` with empty data, making it impossible for consumers
to distinguish "server error" from "no data exists." The pattern should be consistent: either always throw on
`response.error`, or always use the error-swallowing approach.

### 11. `useCollabDocumentInfo` swallows errors as permission denial

`packages/lib/src/core/collab/hooks/use-collab.ts:22-24`

```typescript
if (response.error) {
    console.error('Error fetching document info:', response.error);
    return {canRead: false, canWrite: false, path: null, folderContents: null};
}
```

An API error (500, network failure, etc.) is logged then returned as `{canRead: false, canWrite: false}`. The query
reports success. Consumers cannot distinguish "server error" from "user lacks permission." This could lock users out of
documents they should have access to when the API is temporarily unavailable.

### 12. Hardcoded colors in two UI components

`packages/ui/src/components/layout/home/usage.tsx:21`

```typescript
if (storageUsed > 0.85) return "bg-red-500";
else if (storageUsed > 0.65) return "bg-yellow-500";
```

`packages/ui/src/components/layout/mount/mount-form.tsx:220`

```typescript
${s3Check.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}
```

CLAUDE.md states "Use theme tokens, not hardcoded colors." The storage usage colors should use `bg-destructive` and
`bg-warning` (or similar tokens). The mount form's success color uses hardcoded green with a dark mode variant rather
than a semantic token. Note that the error case correctly uses `text-destructive`.

### 13. `ShadowContent` uses hardcoded colors inside shadow DOM

`packages/ui/src/components/layout/shadow-content.tsx:62-65`

```css
color: #333;
a { color: #0066cc; }
```

These hardcoded hex colors inside the shadow DOM will not respect dark mode. When the app is in dark mode, email content
will still render with dark-on-light colors. The shadow DOM is intentionally isolated from app styles, so this requires
a different solution -- perhaps injecting CSS custom properties from the host.

### 14. `localIdCounter` is a module-level mutable shared across all chat rooms

`packages/lib/src/core/chat/hooks/use-chat-room.ts:15`

```typescript
let localIdCounter = 0;
```

This counter is shared across all `useChatRoom` instances and never resets. While harmless (IDs are prefixed with
`local-`), it would be cleaner as a `useRef` inside the hook to avoid leaking state between instances.

---

## Minor Issues

### 15. Dead export map entries in `packages/lib/package.json`

Lines 19 and 34:
```json
"./admin": "./src/core/admin/index.ts",
"./stickies": "./src/core/stickies/index.ts",
```

Neither `packages/lib/src/core/admin/` nor `packages/lib/src/core/stickies/` directories exist. Any consumer importing
from `@workspace/lib/admin` or `@workspace/lib/stickies` will get a module resolution error.

### 16. `interface` used instead of `type` in 16 layout components

CONTRIBUTING.md specifies "`type` over `interface` (except when methods needed)." Found 16 `interface` declarations in
`packages/ui/src/components/layout/` that do not require methods:

`shadow-content.tsx:4`, `ket.tsx:3`, `bar.tsx:3`, `bra.tsx:3`, `topbar.tsx:46`, `app-logo.tsx:9`,
`label-provider.tsx:6,28`, `eigen-app.tsx:16`, `sse-provider.tsx:7`, `label-dialog.tsx:36`, `drive-list.tsx:168`,
`context-menu-anchor.tsx:4`, `file-preview.tsx:10`, `upload-with-progress.tsx:5`, `drive-create-folder-item.tsx:9`

Note: `packages/lib/src/` has zero `interface` declarations -- the rule is being followed there.

### 17. `"use client"` directives are no-ops in this Vite project

41 files in `packages/ui/src/components/` have `"use client"` at the top. Since this is a Vite + React project (not
Next.js RSC), these directives have no effect. Many are from shadcn/ui component templates and are harmless, but they
add confusion about the rendering model. Custom layout components also carry them: `eigen-app.tsx`, `sse-provider.tsx`,
`upload-provider.tsx`, `preview-provider.tsx`, `user-avatar.tsx`, `user-item.tsx`, `user-name.tsx`.

### 18. `DriveLayoutProps.error` and `onAfterAction` typed as `any`

`packages/ui/src/components/layout/drive/drive-layout.tsx:29,35`

```typescript
error: any;
onAfterAction?: (actionType: string, data: any) => void;
```

`error` should be `Error | null`. `onAfterAction`'s `data` parameter should be `unknown` or a discriminated union.

### 19. `mailboxKeys.list` accepts `Record<string, any>` and is unused

`packages/lib/src/core/mail/hooks/use-mailboxes.ts:8`

```typescript
list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
```

This key factory accepts `any`-typed filters and is never called anywhere (the `useMailboxes` hook uses
`mailboxKeys.lists()` directly). It is dead code that also erodes type safety.

### 20. `useAuthClient` wraps a module-level singleton in `useQuery` unnecessarily

`packages/lib/src/core/auth/hooks/use-auth-client.ts:27-31`

```typescript
export function useAuthClient() {
    return useQuery({
        queryKey: ['auth-client'],
        queryFn: () => authClient
    })
}
```

The `queryFn` returns the already-available `authClient` module singleton. No async work is performed. This could be a
direct export. The `useQuery` wrapper adds unnecessary complexity: `isLoading` is only true on the very first render,
and the "data" never changes.

### 21. `apps.ts` uses hardcoded Tailwind color classes for app icons

`packages/lib/src/core/apps.ts:17-83`

Each app entry has a `className` like `text-teal-600`, `text-blue-600`, etc. These are not theme tokens. Since these
represent app brand colors (not UI state), this is arguably intentional, but it does mean the app icons will not adapt
to dark mode themes.

### 22. `date.ts` wraps Date in redundant `new Date()`

`packages/lib/src/core/date.ts:2,6`

```typescript
export function formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
```

The parameter is typed as `Date`, but the function wraps it in `new Date(date)` before calling `.toLocaleTimeString()`.
If the input is already a `Date`, this is redundant. If the input might be a string (from JSON deserialization), the
type annotation is wrong. This pattern suggests the type says `Date` but callers pass ISO strings.

---

## Strengths

1. **Zero `as any` in `packages/lib/src/`**: The previous review noted 21 `as any` casts; all have been cleaned up. The
   Eden Treaty type-safety pipeline is now unbroken throughout the hook layer.

2. **Consistent query key architecture**: Drive keys are properly scoped with `ownerId` at every level via the `owner()`
   base factory. The hierarchical key pattern enables surgical invalidation (e.g., invalidating a specific folder
   without touching the root).

3. **Clean SSE invalidation pipeline**: Each domain's SSE handler maps event types to specific invalidation functions
   co-located with the hooks. This ensures SSE events and `onSuccess` callbacks use the same invalidation logic,
   preventing drift.

4. **Well-composed list hooks**: `useListSelection`, `useKeyboardListNavigation`, `useListDrag`, and `useListDropTarget`
   are generic, composable, and handle edge cases (Shift+click range, Ctrl+A, Home/End, drag badge for multi-select).
   The selection hook correctly uses functional state updates.

5. **Type-safe SSE event system**: `SSEvent` is a well-designed discriminated union with per-domain payload types. The
   `isSSEventNotification` type guard cleanly separates notification events from data-only events. The `SSEventType`
   const object provides a single source of truth for event type strings.

6. **Comprehensive drive file type system**: `packages/lib/src/types/drive.ts` provides constants, type guards (
   `isCollabType`, `isChatType`, `isContainerType`), inline-editable MIME/extension sets, and the `DrivePath` type that
   flows through the entire drive UI.

7. **Provider stack ordering**: `EigenApp` correctly nests providers so that auth resolves before SSE connects, SSE is
   available before upload/preview, and toasts can fire from anywhere in the tree.

8. **Shared validation layer**: `packages/lib/src/validation/` provides email, ACL, and chat command validation that is
   shared between frontend and backend, preventing divergence.

9. **Responsive layout system**: `ColumnLayout`/`Column` handles mobile/desktop switching cleanly with a single
   `mobileColumn` prop. The `SidebarContainer` adapts between full/condensed/overlay modes based on device size.

---

## File Index

| Area            | Key Files                                                                                                     |
|-----------------|---------------------------------------------------------------------------------------------------------------|
| API client      | `packages/lib/src/core/api.ts`                                                                                |
| Drive hooks     | `packages/lib/src/core/drive/hooks/use-drive.ts`, `use-drive-access.ts`                                       |
| Mail hooks      | `packages/lib/src/core/mail/hooks/use-emails.ts`, `use-mailboxes.ts`, `use-draft.ts`                          |
| Contact hooks   | `packages/lib/src/core/contacts/hooks/use-contacts.ts`, `use-labels.ts`                                       |
| Chat hooks      | `packages/lib/src/core/chat/hooks/use-chat.ts`, `use-chat-room.ts`                                            |
| Calendar hooks  | `packages/lib/src/core/calendar/hooks/use-calendar.ts`                                                        |
| SSE             | `packages/lib/src/core/sse/hooks/use-sse.ts`                                                                  |
| SSE handlers    | `packages/lib/src/core/[domain]/sse-handlers.ts` (drive, mail, contacts, chat, calendar, space, team)         |
| Types           | `packages/lib/src/types/` (drive, mail, contact, chat, calendar, sse, owner, etc.)                            |
| Validation      | `packages/lib/src/validation/` (email, acl, command)                                                          |
| App shell       | `packages/ui/src/components/layout/app/eigen-app.tsx`, `app-shell.tsx`, `column-layout.tsx`                   |
| Providers       | `sse-provider.tsx`, `upload-provider.tsx`, `preview-provider.tsx`, `label-provider.tsx`, `theme-provider.tsx` |
| Drive UI        | `packages/ui/src/components/layout/drive/drive-layout.tsx`, `drive-table.tsx`, `drive-list.tsx`               |
| List hooks      | `packages/ui/src/hooks/use-list-selection.ts`, `use-keyboard-list-navigation.ts`, `use-list-drag.ts`          |
| User components | `packages/ui/src/components/layout/user-avatar.tsx`, `user-item.tsx`, `user-name.tsx`                         |

Related
docs: [LAYOUT.md](../docs/LAYOUT.md), [SSE.md](../docs/SSE.md), [CONTRIBUTING.md](../docs/CONTRIBUTING.md), [HOTKEYS.md](../docs/HOTKEYS.md), [LAYOUT-SHARED-COMPONENTS.md](../docs/LAYOUT-SHARED-COMPONENTS.md), [LAYOUT-UI-LIST.md](../docs/LAYOUT-UI-LIST.md), [LAYOUT-UI-DRIVE.md](../docs/LAYOUT-UI-DRIVE.md)
