# Code Review: packages/lib

## Summary

`packages/lib` is the shared logic layer providing Eden Treaty API client, TanStack Query hooks, SSE handlers, shared
types, validation, and constants. The package is well-structured with clear domain separation. Query key patterns are
consistent and SSE handlers properly reuse invalidation functions from hooks. However, several issues around missing
`ownerId` in query keys, missing error handling on mutations, and a critical bug in `useCreateChat` need attention.

## Critical Issues

### 1. `useCreateChat` passes wrong arguments to `invalidateItemCreated`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/chat/hooks/use-chat.ts`, line 63
**Issue**: `invalidateItemCreated` is called with `(queryClient, mountId, variables.parentId, 'DRIVE_MIME_CHAT')` but
the function signature expects `(queryClient, ownerId, mountId, parentId, mimeType)`. The `ownerId` argument is missing
-- `mountId` is passed where `ownerId` should be, so folder invalidation targets the wrong cache key.
**Impact**: After creating a chat room, the parent folder cache is never correctly invalidated. The new chat won't
appear
until the user manually refreshes.
**Fix**: Change to `invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_CHAT')`.

### 2. `useAuthClient` wraps a module-level singleton in `useQuery`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/auth/hooks/use-auth-client.ts`, lines 27-32
**Issue**: `useAuthClient` wraps the already-instantiated `authClient` in a `useQuery` that simply returns it. This
creates an unnecessary query cache entry and a misleading hook. The `authClient` is a module-level singleton that
requires no fetching.
**Impact**: Low -- functionally harmless but confusing for contributors. Anyone using this hook gets a
`UseQueryResult<typeof authClient>` instead of the client directly, adding unnecessary `.data` unwrapping.
**Fix**: Remove `useAuthClient` hook. Consumers should import `authClient` directly (which is already what every call
site does).

### 3. `ShadowContent` renders unsanitized HTML in Shadow DOM

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/shadow-content.tsx`, line 51
(Cross-reference from lib) The `ShadowContent` component assigns untrusted content directly to the DOM for email bodies.
While Shadow DOM provides style isolation, it does NOT prevent JavaScript execution -- `<img onerror>`, `<svg onload>`,
and similar event handler attributes still execute in the main document context.
**Impact**: XSS risk when rendering untrusted email HTML.
**Fix**: Sanitize HTML content before insertion using DOMPurify or a similar library. Shadow DOM alone is not a security
boundary for script execution.

## Pattern Violations

### 4. Missing `ownerId` in mail/contacts/calendar/home query keys

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, lines 7-12
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-mailboxes.ts`, lines 4-12
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/contacts/hooks/use-contacts.ts`, lines 8-15
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/contacts/hooks/use-labels.ts`, lines 8-14
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/calendar/hooks/use-calendar.ts`, lines 14-22
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/home/hooks/use-home.ts`, lines 8-10
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/space/hooks/use-space-settings.ts`, lines 7-9

**Issue**: CLAUDE.md explicitly states: "Query keys must include `ownerId` for any owner-scoped data. Without it,
switching between personal and team contexts serves stale cached data from the wrong owner." The Drive domain correctly
includes `ownerId` in all keys. Mail, Contacts, Labels, Calendar, Home, and Space do not.
**Impact**: If the user switches between owners (e.g., personal vs team context) without a full page reload, cached data
from the previous owner will be served. While mail/contacts are currently user-only, calendar already supports team
calendars, making this a live bug.
**Fix**: Add `ownerId` as the second segment in all query key hierarchies for these domains, following the pattern
established by `driveKeys`.

### 5. `"use client"` directives in a Vite project

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/sse-provider/sse-provider.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-provider.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-container.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/preview-provider/preview-provider.tsx`,
  line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-avatar.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, line 1

**Issue**: CLAUDE.md: "No `"use client"` directives -- this is a Vite project, not Next.js. The directive is a no-op."
**Impact**: No functional impact but violates project convention and can confuse contributors.
**Fix**: Remove all `"use client"` directives.

### 6. `interface` used instead of `type` in several places

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, line 16 (
  `interface EigenAppProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/topbar.tsx`, line 28 (
  `interface TopbarProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/labels/label-provider.tsx`, line 7
  (`interface LabelContextType`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/labels/label-dialog.tsx`, line 36
  (`interface LabelDialogProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/shadow-content.tsx`, line 4
  (`interface ShadowContentProps`)

**Issue**: CLAUDE.md: "Always `type` over `interface` -- except when methods are needed." These interfaces contain no
methods; they should be `type` aliases.
**Fix**: Convert to `type` aliases.

### 7. JSDoc comment present in `useMediaQuery`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/media/hooks/use-media-query.ts`, lines 7-10
**Issue**: CLAUDE.md: "No JSDoc -- code should be self-documenting, minimal comments."
**Fix**: Remove the JSDoc block.

## Security Concerns

### 8. `DeleteDialog` renders user-provided content unsafely

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/delete/delete-dialog.tsx`, line 36
**Issue**: The `formattedDescription` string is built with `<b>${itemName}</b>` and then rendered as raw HTML via
the `dangerouslySetInnerHTML` prop. If `itemName` contains HTML (e.g., a malicious filename), it will be interpreted
as markup. This is an XSS vector.
**Impact**: Stored XSS if an attacker names a file/folder with script-injecting HTML, then another user tries to delete
it.
**Fix**: Use React elements instead of raw HTML rendering:

```tsx
<DialogDescription>
    {description} <b>{itemName}</b>? This action cannot be undone.
</DialogDescription>
```

### 9. Owner ID UUID regex is too permissive

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/types/owner.ts`, line 24
**Issue**: The regex `/^[0-9a-fA-Z]{32}$/i` uses `a-fA-Z` instead of `a-fA-F`, accepting characters `G-Z` as valid hex.
Additionally, standard UUIDs are 32 hex characters without hyphens or 36 characters with hyphens; the regex enforces no
hyphens. If the codebase uses hyphenated UUIDs anywhere, valid IDs would fail validation.
**Impact**: Accepts invalid owner IDs that would never match a real user, potentially masking bugs. Also allows crafted
IDs that bypass intended validation.
**Fix**: Use `/^[0-9a-f]{32}$/i` (hex only). If UUIDs may include hyphens, also accept
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.

### 10. Email regex allows some unusual characters

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/validation/email.ts`, line 1
**Issue**: `EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` is overly permissive -- it accepts strings like
`a@b.c` and allows control characters and quotes in the local part which could cause issues if used in HTTP headers or
HTML contexts.
**Impact**: Low for validation purposes, but email addresses could contain characters hazardous in other contexts.
**Fix**: Acceptable for FE validation, but worth noting.

### 11. ACL validation uses `parseOwnerId` instead of `validateEmailAddress`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/validation/acl.ts`, lines 3-9
**Issue**: `validateACLEntries` checks `parseOwnerId(entry.id).id === ''` to reject invalid entries. But `parseOwnerId`
returns a non-empty `id` for any string that matches the loose UUID regex. For ACL entries that are email addresses (the
common case for sharing), this function would fail them as invalid since emails aren't UUIDs -- except that
`parseOwnerId` also accepts valid emails on line 10-11. This creates an inconsistent code path: emails are validated by
the email regex, while team/org IDs are validated by the UUID regex.
**Impact**: If an ACL entry is neither a valid email nor a valid UUID, it gets silently accepted if it matches the loose
`a-fA-Z` regex.
**Fix**: Validate email ACL entries with `validateEmailAddress` and UUID entries with a proper hex regex.

## Data Integrity

### 12. Mutations lack error feedback (missing `onError` / try-catch)

**Files affected** (non-exhaustive list):

- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/drive/hooks/use-drive.ts`: `useCreateFolder` (line 106),
  `useUploadFile` (line 118), `useUploadFiles` (line 130), `useDeleteFolder` (line 142), `useDeleteFile` (line 154),
  `useMovePath` (line 165), `useRenamePath` (line 176), `useUpdateACL` (line 188)
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/chat/hooks/use-chat.ts`: `useCreateChat` (line 56)
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/contacts/hooks/use-labels.ts`: `useAddLabel`,
  `useUpdateLabel`, `useDeleteLabel`
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-draft.ts`: `useUpdateDraft`,
  `useSendDraft`

**Issue**: CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`, or
use the `onError` callback. Never swallow errors." These mutation hooks define no `onError` callback. If the API returns
an error, it silently fails and the `onSuccess` handler never runs, leaving the user with no feedback.
**Impact**: Users get no indication when operations fail. They may believe a file was deleted/created/moved when it
wasn't.
**Fix**: Add `onError` callbacks that call `toast.error()` with a meaningful message, or document that the calling
component is expected to use `mutateAsync` with its own try/catch (but currently most don't).

### 13. `useFolderContent` / `useMimeContent` return `[]` on error after throwing

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/drive/hooks/use-drive.ts`, lines 62-65, 79-82
**Issue**: When `response.error` is truthy, the `queryFn` throws an error. But the `|| []` fallback on the data line is
unreachable because the throw happens first. This is not a bug but dead code that could mislead maintainers into
thinking errors return empty arrays.
**Impact**: None -- error behavior is correct. But the fallback `|| []` suggests the error is swallowed.
**Fix**: Remove the `throw` and rely on the empty array fallback, or remove the unreachable `|| []`.

### 14. `useSSE` creates new `EventSource` on every `handleEvent` reference change

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/sse/hooks/use-sse.ts`, line 59
**Issue**: The `useEffect` dependency array includes `handleEvent`, which is a `useCallback` depending on
`[onNotification, queryClient]`. If the consumer passes a new `onNotification` callback on every render (anonymous
function), the EventSource will be torn down and reconnected on every render.
**Impact**: SSE connection churn causing missed events and unnecessary server load. The SSEProvider wraps
`onNotification` in `useCallback` (line 12 of `sse-provider.tsx`), so this is currently mitigated, but it's fragile.
**Fix**: Store `handleEvent` in a ref rather than including it in the effect deps, so the EventSource connection is
stable. Only reconnect when `user.id` changes.

### 15. `isConnected` in `useSSE` returns a snapshot, not reactive state

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/sse/hooks/use-sse.ts`, line 62
**Issue**: `eventSourceRef.current?.readyState === EventSource.OPEN` is computed on each render but reads from a ref,
which doesn't trigger re-renders when the connection state changes. The returned `isConnected` is always the state at
render time, not a live reactive value.
**Impact**: Consumers that use `isConnected` to show connection status will show stale values.
**Fix**: Track connection state in `useState` and update it via `eventSource.onopen` / `eventSource.onerror` handlers.

## Code Quality

### 16. `as any` type in AppShell `rootRoute` prop

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/app-shell.tsx`, line 12
**Issue**: `rootRoute.useNavigate: () => (...args: any[]) => any` uses `any` twice. CLAUDE.md: "Never use `as any`."
While this is `any` in a type annotation rather than a cast, the principle applies -- the navigate function should be
properly typed.
**Fix**: Import TanStack Router's `NavigateOptions` type or at minimum use `unknown` instead of `any`.

### 17. Duplicated user-resolution logic across `UserAvatar`, `UserItem`, `UserName`

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-avatar.tsx`, lines 33-44
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, lines 35-48
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, lines 32-43

**Issue**: All three components independently call `useContacts()`, `usePublicUser()`, `usePublicConfig()`, and
`usePeopleTeams()` and then run the exact same display-name resolution logic. This is ~15 lines of identical logic
repeated 3 times.
**Impact**: Maintenance burden -- any fix to name resolution must be applied in 3 places. Also triggers 4 hooks per
component instance, which is wasteful when `UserItem` already renders an avatar (double the hook calls).
**Fix**: Extract a `useResolvedUser(userId, email)` hook that returns `{displayName, resolvedEmail, avatarSrc}`.

### 18. `useMediaQuery` initial value can cause layout flicker

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/media/hooks/use-media-query.ts`, line 9
**Issue**: `useState(false)` as initial value means on first render, `matches` is always `false` regardless of the
actual media query result. The `useEffect` then updates it. This means `useIsMobile()` returns `false` on the first
synchronous render, which could cause layout flicker for mobile users.
**Impact**: Low in SPA context but worth noting.
**Fix**: Initialize with `window.matchMedia(query).matches`.

### 19. `index.ts` barrel re-exports use `@workspace/ui/core/*` paths

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/index.ts`, lines 2-10
**Issue**: The barrel file re-exports from `@workspace/ui/core/*` paths. This looks like it should be
`@workspace/lib/core/*`. This might be a path alias configuration that maps correctly, but it's confusing -- the lib
package referencing paths that appear to be in the ui package.
**Impact**: Works if path aliases are configured correctly, but misleading. Could break if path aliases change.
**Fix**: Verify the path aliases and rename for clarity if appropriate.

### 20. Missing `calendar` and `chat` types from `types/index.ts` re-exports

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/types/index.ts`
**Issue**: The barrel file re-exports `clipboard`, `collab`, `contact`, `drive`, `label`, `mail`, `mount`, `owner`,
`sse`, `people`, `public`, `settings` -- but not `calendar` or `chat`. These types exist but aren't re-exported from the
barrel.
**Impact**: Consumers must import calendar/chat types from deep paths instead of `@workspace/lib/types`.
**Fix**: Add `export * from './calendar';` and `export * from './chat';` to the barrel.

### 21. `date.ts` wraps Date in new Date unnecessarily

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/date.ts`, lines 2, 6
**Issue**: `formatTime` and `formatDate` accept `Date` but immediately wrap in `new Date(date)`. If `date` is already a
`Date`, this is redundant. If it might be a string, the function signature is misleading.
**Impact**: No bugs, but suggests the parameter should be typed `Date | string` or the wrapping removed.
**Fix**: Accept `Date | string | number` and make the wrapping explicit, or remove the wrapping and require callers to
pass a `Date`.

### 22. `getLocalCommand` duplicates validation logic from `validateCommand`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/chat/commands.ts`, lines 42-77
**Issue**: `getLocalCommand` first calls `validateCommand` for validation, then re-parses the same string with its own
`startsWith` checks. The two functions can get out of sync if new commands are added to one but not the other.
**Impact**: Maintenance risk -- adding a new local command requires changes in both functions.
**Fix**: Have `validateCommand` return structured data that `getLocalCommand` can directly use, or merge them.

## Architecture

### 23. Circular-ish cross-domain dependency in team SSE handler

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/team/sse-handlers.ts`, line 5
**Issue**: The team SSE handler imports `calendarKeys` from `../calendar/hooks/use-calendar` to invalidate shared
calendars when team settings change. This creates a cross-domain dependency (team -> calendar).
**Impact**: Not a circular dependency, but it couples the team domain to calendar internals. If calendar keys change,
the
team SSE handler breaks.
**Fix**: Calendar should export an `invalidateCalendarForTeam(queryClient)` function that the team handler calls,
keeping
the calendar key structure internal to the calendar domain.

### 24. `useAuth` hook reads from context but mail/contacts hooks call it internally

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/contacts/hooks/use-contacts.ts`
- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/contacts/hooks/use-labels.ts`

**Issue**: These hooks call `useAuth()` internally to get `user.id` as `ownerId`. In contrast, Drive hooks accept
`ownerId` as a parameter. This means mail/contacts hooks are tightly coupled to the auth context and cannot be used for
team-owned data (if that's ever needed).
**Impact**: Inconsistency. Drive hooks are flexible (work with user or team owners). Mail/contacts hooks are locked to
the current user.
**Fix**: For consistency, accept `ownerId` as a parameter in mail/contacts hooks, matching the Drive pattern. This also
resolves the missing-ownerId-in-query-keys issue (item 4).

## Positive Patterns

- **Query key hierarchies in Drive** are exemplary -- properly scoped with `ownerId`, well-organized, and all
  invalidation functions are co-located with the hooks that define the keys.
- **SSE handler architecture** is clean: each domain owns its handler, handlers reuse the same invalidation functions
  used by mutations, and registration in `use-sse.ts` is straightforward.
- **Eden Treaty usage** is consistent -- the type-safe API client is used everywhere without `as any` casts (except
  the `as` casts in `useCollabDocumentInfo` and `useTextPreview` which should be addressed by fixing route types).
- **Shared validation** in `packages/lib/src/validation/` provides reusable FE/BE validation with clean separation.
- **MIME type constants** in `drive.ts` are properly defined as `const` assertions, preventing typo-related bugs.
- **Clipboard module** is well-designed with clear separation of concerns (read/write/re-upload).

## Recommendations

### P0 (Fix immediately -- bugs or security issues)

1. **Fix `useCreateChat` argument order** (item 1) -- silent cache invalidation failure
2. **Add `ownerId` to mail/contacts/calendar/home/space query keys** (item 4) -- data integrity risk with team contexts
3. **Sanitize HTML in `ShadowContent` and `DeleteDialog`** (items 3, 8) -- XSS vectors
4. **Add `onError` callbacks to mutations** (item 12) -- silent failures with no user feedback

### P1 (Fix soon -- pattern violations and maintainability)

5. **Fix owner ID UUID regex** (item 9) -- accepts invalid characters
6. **Remove `"use client"` directives** (item 5) -- 8 files, simple cleanup
7. **Convert `interface` to `type`** (item 6) -- convention violation
8. **Stabilize `useSSE` EventSource connection** (item 14) -- fragile reconnection behavior
9. **Add missing `calendar`/`chat` types to barrel** (item 20)
10. **Extract shared user-resolution hook** (item 17) -- triplicated logic

### P2 (Nice to have -- cleanup and consistency)

11. **Remove `useAuthClient` hook** (item 2) -- dead/misleading code
12. **Remove JSDoc from `useMediaQuery`** (item 7)
13. **Initialize `useMediaQuery` with actual media match** (item 18)
14. **Fix `date.ts` double Date wrapping** (item 21)
15. **Accept `ownerId` param in mail/contacts hooks** (item 24) -- architectural consistency
16. **Merge `getLocalCommand` and `validateCommand`** (item 22)
17. **Decouple team SSE handler from calendar keys** (item 23)
