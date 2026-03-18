# Frontend Review: Shared Packages (packages/lib + packages/ui)

**Scope:** `packages/lib/`, `packages/ui/`
**Reviewed:** 2026-03-18

## Critical Issues

**1. Rules of Hooks violation: conditional hook call in `DriveListToolbar`**
`packages/ui/src/components/layout/drive/drive-list.tsx:58`

```typescript
const {data: breadcrumbPaths = []} = showBreadcrumb ? useBreadcrumb(ownerId, mountId, pathId) : {data: []};
```

`useBreadcrumb` is called conditionally based on the `showBreadcrumb` prop. This violates React's Rules of Hooks -- hooks must be called unconditionally on every render. If `showBreadcrumb` changes between renders, React will produce incorrect state or crash. The fix is to always call the hook and use the `enabled` option:

```typescript
const {data: breadcrumbPaths = []} = useBreadcrumb(ownerId, mountId, pathId);
// Then conditionally render breadcrumb UI based on showBreadcrumb
```

Or pass `enabled: showBreadcrumb` into the hook. This is new.

**2. Drive query keys omit `ownerId`, causing cross-owner cache collisions**
`packages/lib/src/core/drive/hooks/use-drive.ts:10-26`

The `driveKeys` factory excludes `ownerId` from most keys: `folder`, `path`, `read`, `write`, `textPreview`, `mounts`, `shared`, and `mime`. Only `root()` includes `ownerId`. Yet the actual query functions all pass `ownerId` to the API. When a user views their own drive and then a team drive, cache keys like `['drive', 'folder', 'default', '<pathId>']` collide, and stale data from one owner is served for the other.

Similarly, the invalidation functions (`invalidateItemCreated`, `invalidatePathMoved`, etc.) do not scope by ownerId, meaning an SSE event for a team drive invalidation will also affect the user's personal drive cache entries that happen to share the same mountId+pathId structure.

Fix: Add `ownerId` as the first parameter after the domain prefix in all keys that are not inherently global. Confirmed from previous review.

**3. UUID validation regex accepts invalid characters**
`packages/lib/src/types/owner.ts:24`

```typescript
const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
```

The character class `a-fA-Z` matches all letters A-Z, not just hex digits A-F. A string like `00000000000000000000000000000zzz` passes this regex. The `i` flag makes the explicit upper range redundant. Should be `/^[0-9a-f]{32}$/i`. Additionally, the regex validates dashless 32-char hex strings, but the system's UUIDs are standard 36-char dashed format -- this means `parseOwnerId` silently returns `{type: 'user', id: ''}` for any raw UUID with dashes, falling through to the validation check. This works only because the `validateEmailAddress` check on line 10 catches email-format IDs first, and the `team_`/`org_` prefix stripping on lines 14-19 leaves just the 32-char hex portion. Still, the regex should be correct. Confirmed from previous review.

## Important Issues

**4. `MAIL_SENT` SSE event handler is a no-op**
`packages/lib/src/core/mail/sse-handlers.ts:60-61`

```typescript
case SSEventType.MAIL_SENT:
    return true;
```

The handler matches the event but performs no cache invalidation. After sending an email, the Sent mailbox list remains stale until its staleTime expires or the user manually navigates away and back. Should at minimum call `invalidateMailMoved(queryClient, mail.messageId, 'Drafts', 'Sent')` and `invalidateMailboxes(queryClient)`. Confirmed from previous review.

**5. Pervasive `as any` casts in calendar hooks erase type safety**
`packages/lib/src/core/calendar/hooks/use-calendar.ts` -- 12 occurrences (lines 56, 69, 83, 95, 108, 121, 134, 146, 161, 194, 227-228)

Nearly every calendar API call casts the Eden Treaty chain to `any`:
```typescript
const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events.post(eventData as any);
```

This defeats the type-safe API client entirely. If the API renames a parameter or changes a type, these will silently break at runtime instead of failing at build. This is the biggest type safety gap in the frontend. The Elysia route definitions for calendar probably use nested path parameters that Eden Treaty doesn't map cleanly -- the route types should be adjusted so Eden generates correct types. Confirmed from previous review; count verified at 12 (not 13).

**6. Additional `as any` casts across other hooks (21 total across all hook files)**
- `packages/lib/src/core/mail/hooks/use-emails.ts:23` -- dynamic property access via `as any` on mailbox path
- `packages/lib/src/core/contacts/hooks/use-labels.ts:40,58` -- label post/put bodies
- `packages/lib/src/core/team/hooks/use-team-mounts.ts:27,40` -- mount post/put bodies
- `packages/lib/src/core/settings/hooks/use-server-settings.ts:26` -- settings put body
- `packages/lib/src/core/settings/hooks/use-s3-config.ts:26` -- s3config put body
- `packages/lib/src/core/people/hooks/use-members.ts:35,77` -- `role: role as any`

Confirmed from previous review. The total `as any` count across `packages/lib/src` is 21 occurrences.

**7. Draft mutation hooks swallow errors, making `isError` state unreachable**
`packages/lib/src/core/mail/hooks/use-draft.ts:22-44`

Both `updateDraftEmail` and `sendDraftEmail` wrap API calls in try/catch and return `null` on failure instead of re-throwing. Since `useMutation` relies on thrown errors to set `isError`, consumers using `useSendDraft().isError` will never see `true`. The error is logged but not propagated. Fix: remove the try/catch or re-throw after logging. Confirmed from previous review.

**8. `useSSE` `isConnected` is a stale snapshot, not reactive state**
`packages/lib/src/core/sse/hooks/use-sse.ts:62-64`

```typescript
return {
    isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
};
```

This is computed from a ref at render time and never triggers re-renders when the connection drops or reconnects. Any component reading `isConnected` gets a stale value. Should use `useState` updated via `eventSource.onopen`/`eventSource.onerror` handlers. Confirmed from previous review.

**9. `console.log` in production SSE path**
`packages/lib/src/core/sse/hooks/use-sse.ts:50`

```typescript
console.log('Received SSE event', sseEvent);
```

Every SSE event logs the full event object. This is noisy and a minor performance concern for high-frequency events (e.g., `CHAT_TYPING`). Confirmed from previous review.

**10. Module-level singleton `QueryClient`**
`packages/ui/src/components/layout/app/eigen-app.tsx:21`

```typescript
const queryClient = new QueryClient();
```

Created at module scope rather than inside the component. This means all `EigenApp` instances share the same cache. In practice this is likely fine since there is one instance per app, but it prevents proper isolation and is a known anti-pattern (e.g., if the module ever gets loaded in a testing or SSR context). Standard practice: `const [queryClient] = useState(() => new QueryClient())`. Confirmed from previous review.

**11. `UploadProvider.removeUpload` reads stale `uploads` closure**
`packages/ui/src/components/layout/upload-provider/upload-provider.tsx:86-88`

```typescript
removeUpload: (id) => {
    const upload = uploads.find(u => u.id === id)
    if (upload?.cancelFn) upload.cancelFn()
    setUploads(prev => prev.filter(upload => upload.id !== id))
}
```

The `contextValue` object is recreated every render (it is not memoized), and the `removeUpload` function captures the `uploads` state from the current render closure. However, since `contextValue` is a new object each render, every consumer re-renders on every upload state change. The `uploads.find` call uses the closure value which could be stale if called from an event handler after a state update. The `setUploads` correctly uses functional form, but the `cancelFn` lookup might find a stale upload. `contextValue` should be memoized with `useMemo` or the functions extracted with `useCallback`. This is new.

**12. Chat `useMessages` polls every 5 seconds alongside SSE**
`packages/lib/src/core/chat/hooks/use-chat.ts:34`

```typescript
refetchInterval: 5000,
```

Messages are already invalidated by SSE events (`handleChatSSEvent` calls `invalidateMessages`). The 5-second polling is redundant when SSE is connected and generates unnecessary network traffic. Consider removing the polling or making it conditional on SSE connection status. Confirmed from previous review.

**13. `UserAvatar`, `UserItem`, and `UserName` have triplicated user resolution logic**
`packages/ui/src/components/layout/user-avatar.tsx:33-44`
`packages/ui/src/components/layout/user-item.tsx:35-48`
`packages/ui/src/components/layout/user-name.tsx:32-43`

All three components independently:
1. Call `useContacts()` to get the full contact list
2. Call `usePublicUser(userId || email || '')`
3. Call `usePublicConfig()` to get the org ID
4. Call `usePeopleTeams(org?.orgId)` for team name resolution
5. Compute `displayName` with the identical fallback chain
6. Find contact by email with identical logic

This is 4 queries per component instance. In a chat message list with 20 messages, that is `UserAvatar` per message plus potential `InlineEmail` components, each triggering the same 4 queries. TanStack Query deduplicates, but the logic duplication is a maintenance burden -- a change to the display name fallback chain must be made in three places.

Fix: Extract into a `useResolvedUser(emailOrId)` hook that returns `{displayName, avatarSrc, resolvedEmail, isLoading}`. Confirmed from previous review; extended to note `UserName` as a third copy.

**14. `parseOwnerId` falls through from `team_` check to `org_` check**
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

These are two separate `if` statements, not `if/else if`. A string starting with `team_` will match the first condition, set `type = 'team'` and `id` to the sliced value, then also be checked against `org_` (which won't match, but costs an unnecessary check). More importantly, if someone constructed `org_team_abc`, both branches would execute. The second `if` should be `else if`. This is new.

## Minor Issues

**15. Dutch comment in English-only codebase**
`packages/lib/src/core/contacts/hooks/use-labels.ts:7`

```typescript
// Definieer query keys voor hergebruik
```

CLAUDE.md states "English everywhere". Should be "Define query keys for reuse". Confirmed from previous review.

**16. Dead export map entries in `packages/lib/package.json`**
Lines 19 and 34:
```json
"./admin": "./src/core/admin/index.ts",
"./stickies": "./src/core/stickies/index.ts",
```

Neither `packages/lib/src/core/admin/` nor `packages/lib/src/core/stickies/` exist. Any consumer importing from `@workspace/lib/admin` or `@workspace/lib/stickies` will get a module resolution failure. Confirmed from previous review via glob search.

**17. `interface` used instead of `type` in 16 locations**
CONTRIBUTING.md says "Always `type` over `interface` (except when methods needed)." Found 16 `interface` declarations in packages/ui layout components, none of which require methods:

`eigen-app.tsx:16`, `topbar.tsx:46`, `label-provider.tsx:6,28`, `label-dialog.tsx:36`, `drive-create-folder-item.tsx:9`, `file-preview.tsx:10`, `drive-list.tsx:168`, `shadow-content.tsx:4`, `upload-with-progress.tsx:5`, `context-menu-anchor.tsx:4`, `sse-provider.tsx:7`, `app-logo.tsx:9`, `bra.tsx:3`, `ket.tsx:3`, `bar.tsx:3`

Confirmed from previous review.

**18. `"use client"` directives have no effect**
41 files in `packages/ui/src/components/` have `"use client"` at the top. Since this is a Vite + React project (not Next.js RSC), these directives are inert. Many are from shadcn/ui component templates and are harmless but add confusion about the rendering model. The custom layout components (`eigen-app.tsx`, `sse-provider.tsx`, `upload-provider.tsx`, `upload-container.tsx`, `preview-provider.tsx`, `user-avatar.tsx`, `user-item.tsx`, `user-name.tsx`, `drive-access-list.tsx`, `drive-access-list-edit.tsx`) also have them. Confirmed from previous review; count updated from 10 to 41 (many are shadcn defaults).

**19. `DriveLayoutProps.error` and `onAfterAction` data typed as `any`**
`packages/ui/src/components/layout/drive/drive-layout.tsx:29,35`

```typescript
error: any;
onAfterAction?: (actionType: string, data: any) => void;
```

`error` should be `Error | null`. `onAfterAction` data should use a discriminated union or at least `unknown`. Confirmed from previous review.

**20. `mailboxKeys.list` takes `Record<string, any>` filter parameter**
`packages/lib/src/core/mail/hooks/use-mailboxes.ts:8`

```typescript
list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
```

The `list` key factory accepts `any`-typed filters. This key is never actually used (the hook calls `mailboxKeys.lists()` directly), making it dead code that also erodes types. This is new.

**21. Error handling inconsistency across query hooks**
Some hooks check `response.error` and throw (e.g., `useFolderContent`, `useCreateCalendar`, all contact mutations), while others silently return empty/null data (e.g., `useMounts` returns `[]`, `useRootFolder` returns `null`, `useMailboxes` returns `[]`, `useCalendars` casts and returns `[]`, `useHomeSize` returns `null`). When an API call fails, the latter group reports success with empty data, which is indistinguishable from "no data exists." The pattern should be consistent across all hooks. Confirmed from previous review.

**22. `useCollabDocumentInfo` returns fallback instead of throwing on error**
`packages/lib/src/core/collab/hooks/use-collab.ts:22-24`

```typescript
if (response.error) {
    console.error('Error fetching document info:', response.error);
    return {canRead: false, canWrite: false, path: null, folderContents: null};
}
```

An API error is logged then swallowed, returning a "no permissions" fallback. The query reports success, so consumers cannot distinguish "server error" from "user lacks permission." This is new.

**23. `useAuthClient` hook returns the auth client as query data**
`packages/lib/src/core/auth/hooks/use-auth-client.ts:27-31`

```typescript
export function useAuthClient() {
    return useQuery({
        queryKey: ['auth-client'],
        queryFn: () => authClient
    })
}
```

This wraps a module-level singleton in `useQuery`, which is unusual. The `queryFn` just returns the already-available `authClient` -- it does not fetch anything. The only consumer benefit is a consistent `{data, isLoading}` shape, but `isLoading` will only be true on first render. This could simply be `export { authClient }`. This is new.

**24. `SidebarContainer` mobile overlay renders after the sidebar, creating z-index conflict**
`packages/ui/src/components/layout/sidebar/sidebar-container.tsx:26-42`

On mobile when `sidebarOpen` is true, the sidebar content gets `fixed inset-0 z-50` and the backdrop overlay gets `fixed inset-0 z-40`. Since the sidebar content appears first in the DOM, and the backdrop has a lower z-index, this works correctly -- but the overlay's `onClick` handler to close the sidebar could be occluded by the full-screen sidebar div above it in z-order. In practice, the sidebar content does not fill the full viewport width (it has `w-64`), so clicks on the backdrop area outside the sidebar still work. However, the sidebar div has `inset-0` which makes it full-screen, meaning the backdrop is fully covered. The sidebar content inside will only occupy part of the screen, but the sidebar div's click target covers everything. This means clicking outside the sidebar (on the backdrop) actually clicks on the z-50 sidebar div, not the z-40 backdrop. The close button works because it is inside the sidebar, but tapping the dark overlay area does not close the sidebar.

Fix: The sidebar's container div should not use `inset-0` or should be limited to its actual width so the backdrop behind it is clickable. Confirmed from previous review; analysis updated with root cause.

**25. `localIdCounter` in `useChatRoom` is a module-level mutable that persists across instances**
`packages/lib/src/core/chat/hooks/use-chat-room.ts:15`

```typescript
let localIdCounter = 0;
```

This counter is shared across all `useChatRoom` instances and never resets. While the IDs are prefixed with `local-` and only used for local system messages, the counter grows monotonically across all chat rooms. This is harmless but conceptually wrong -- it would be cleaner to use `useRef` inside the hook. This is new.

## Observations

**Query key consistency.** Each domain defines its own key factory, which is good. But the approach to ownerId varies: drive only includes it in `root()`, calendar includes it in `calendarEvents()`, chat includes it in `messages()`, and mail/contacts/home omit it entirely (relying on `useAuth()` internally). The domains that are inherently single-user (mail, contacts, home) are safe omitting ownerId since TanStack Query is scoped to the single authenticated user's session. But drive, which serves personal and team contexts, needs ownerId in all keys.

**SSE handler coverage is solid.** All 5 implemented domains (Drive, Mail, Contacts, Chat, Calendar) plus Space and Team have handlers registered in `useSSE`. The handler dispatch pattern (prefix check then switch) is consistent and each handler maps to specific invalidation functions. The only gap is `MAIL_SENT` being a no-op (issue #4 above).

**Eden Treaty type safety erosion.** The `as any` casts are concentrated in two areas: calendar hooks (nested path parameters that Eden Treaty does not map cleanly) and various mutation body parameters. The calendar issue is structural -- the Elysia route definitions likely use a pattern that does not produce correct Eden Treaty types for deeply nested resource paths. The other `as any` casts suggest minor mismatches between client types and API expectations. Both should be addressed at the API route definition level rather than with frontend casts.

**Shared UI component library is well-organized.** The layout system (`AppShell`, `ColumnLayout`/`Column`, `SidebarContainer`) provides a consistent shell across all apps. The list hooks (`useListSelection`, `useKeyboardListNavigation`, `useListDrag`) are well-composed with clean generic signatures. The `DriveLayout` successfully abstracts the file browser UI for reuse by Drive, Docs, Stickies, etc.

**Provider stack ordering is correct.** `EigenApp` nests: HotkeysProvider > TooltipProvider > QueryClient > Auth > Theme > SSE > Upload > Preview > Toaster. This ensures auth is resolved before SSE connects, SSE is available before upload/preview, and toasts can fire from anywhere in the tree.

**Validation layer is clean and minimal.** Email validation, ACL validation, and chat command validation are well-separated in `packages/lib/src/validation/`. The command validation is thorough with proper error messages for each command type.
