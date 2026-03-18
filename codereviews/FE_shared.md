# Frontend Code Review: Shared Packages (lib + ui)

## Summary

The shared frontend packages are well-structured and follow a coherent architecture. `packages/lib` centralizes all data
hooks, query keys, SSE handlers, types, and validation in a domain-organized layout. `packages/ui` provides a consistent
layout system with `AppShell`, `ColumnLayout`, providers, and reusable components. The code is generally clean with good
separation of concerns. The issues found are mostly around type safety erosion (`as any` casts), a few inconsistencies in
query key design, stale `"use client"` directives, and some code duplication between `UserAvatar` and `UserItem`.

## Architecture Compliance

**Mostly compliant.** The codebase follows the documented patterns well:

- All data hooks live in `packages/lib/src/core/[domain]/hooks/` -- confirmed no direct `useQuery`/`useMutation` usage
  in app code except one minor exception in `apps/drive/src/components/editor/native-file-editor.tsx` (line 27: uses
  `useQueryClient()` directly for manual invalidation, which is acceptable since it calls `editorKeys` from the shared
  package).
- Query keys follow the hierarchical pattern documented in CONTRIBUTING.md.
- SSE handlers are co-located with their domains and dispatch to the correct invalidation functions.
- Types are in `packages/lib/src/types/`, validation in `packages/lib/src/validation/`.
- Export maps in `package.json` files are organized by domain.
- `EigenApp` correctly stacks providers: HotkeysProvider > TooltipProvider > QueryClient > Auth > Theme > SSE > Upload >
  Preview > Toaster.

## Issues Found

### Critical

**1. Drive query keys omit `ownerId`, causing cross-owner cache collisions**
`packages/lib/src/core/drive/hooks/use-drive.ts` lines 10-26

The `driveKeys` factory only includes `mountId` and `pathId` in most keys (e.g., `folder`, `path`, `read`, `write`,
`textPreview`), but the actual query functions require and use `ownerId`. If a user views folders from different owners
(e.g., their own drive then a team drive), the cache keys will collide because `ownerId` is not part of the key:

```
folder: (mountId, pathId) => [...driveKeys.folders(), mountId, pathId]
```

Should be:

```
folder: (ownerId, mountId, pathId) => [...driveKeys.folders(), ownerId, mountId, pathId]
```

This affects: `folder`, `path`, `read`, `write`, `textPreview`, and all invalidation functions that call them. The
`root` key correctly includes `ownerId` but is the exception. The `mounts`, `shared`, and `mime` keys also omit
`ownerId`. In a single-user scenario this works, but for team drives or shared-with-me paths, stale data from one
owner's folder could be served for another's.

**2. UUID validation regex is incorrect**
`packages/lib/src/types/owner.ts` line 24

```typescript
const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
```

This uses `a-fA-Z` (all letters) instead of `a-fA-F` (hex only), meaning it would accept invalid characters like `g`,
`z` etc. The `i` flag makes `a-fA-Z` pointless since it already covers case, but the range itself is wrong. Also, this
validates only 32-character hex strings without dashes -- this works if the system strips dashes, but the comment says
"check if id is valid uuid" which is misleading.

### Important

**3. Pervasive `as any` casts in calendar hooks erase type safety**
`packages/lib/src/core/calendar/hooks/use-calendar.ts` -- 13 occurrences (lines 56, 69, 83, 95, 108, 121, 134, 146,
161, 194, 227, etc.)

Nearly every calendar API call casts the Eden Treaty chain to `any`:
```typescript
const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events.post(eventData as any);
```
This completely defeats the purpose of the type-safe Eden Treaty client. If the API changes (renames a parameter, changes
a type), these calls will silently break at runtime instead of failing at typecheck. The calendar routes likely need
their Elysia route definitions adjusted to produce correct Eden Treaty types.

**4. `as any` casts in mail `useEmails` hook**
`packages/lib/src/core/mail/hooks/use-emails.ts` line 23

```typescript
const response = await (mailApi({ownerId}).mailbox as any)[path].get();
```

Dynamic property access via `as any` on the mailbox path. This loses all type safety for the mailbox endpoint.

**5. `as any` casts in labels hooks**
`packages/lib/src/core/contacts/hooks/use-labels.ts` lines 40, 58

```typescript
const response = await contactsApi({ownerId}).labels.post(labelData as any);
```

The `as any` on the post/put bodies suggests a type mismatch between the Label type and what the API expects.

**6. `as any` casts in team mount hooks**
`packages/lib/src/core/team/hooks/use-team-mounts.ts` lines 27, 40

**7. `as any` casts in settings hooks**
`packages/lib/src/core/settings/hooks/use-server-settings.ts` line 26
`packages/lib/src/core/settings/hooks/use-s3-config.ts` line 26

**8. `as any` casts in people hooks**
`packages/lib/src/core/people/hooks/use-members.ts` lines 35, 77

```typescript
role: role as any
```

The role parameter is typed as `string` but the API expects a specific union type.

**9. Module-level singleton QueryClient**
`packages/ui/src/components/layout/app/eigen-app.tsx` line 21

```typescript
const queryClient = new QueryClient();
```

The `QueryClient` is created at module scope. This means all apps share a single static instance per module load. If the
module is ever loaded in an SSR context or if multiple `EigenApp` instances are rendered (unlikely but possible), they
will share cache state. The standard practice is to create the client inside the component or via `useState`/`useRef` to
ensure one instance per component tree.

**10. `useSSE` `isConnected` returns a snapshot, not reactive state**
`packages/lib/src/core/sse/hooks/use-sse.ts` lines 62-64

```typescript
return {
    isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
};
```

`eventSourceRef.current` is a ref, so `isConnected` is computed once at render time and never triggers re-renders when
the connection state changes. Any consumer checking `isConnected` will see a stale value. This should use `useState` to
track connection state, updated via `onopen` and `onerror`/`onclose` event handlers.

**11. `console.log` left in production SSE path**
`packages/lib/src/core/sse/hooks/use-sse.ts` line 50

```typescript
console.log('Received SSE event', sseEvent);
```

Every SSE event triggers a console.log. This is noisy in production and a performance concern for high-frequency events.

### Minor

**12. Dutch comment in English-only codebase**
`packages/lib/src/core/contacts/hooks/use-labels.ts` line 7

```typescript
// Definieer query keys voor hergebruik
```

CLAUDE.md and CONTRIBUTING.md state "English everywhere -- code, comments, docs."

**13. `use client` directives are unnecessary**
10 files in `packages/ui/src/components/layout/` have `"use client"` at the top. Since this is a Vite + React project
(not Next.js), these directives have no effect. They add confusion about the rendering model.

Files: `eigen-app.tsx`, `sse-provider.tsx`, `upload-provider.tsx`, `upload-container.tsx`, `preview-provider.tsx`,
`user-avatar.tsx`, `user-item.tsx`, `user-name.tsx`, `drive-access-list.tsx`, `drive-access-list-edit.tsx`

**14. `interface` used instead of `type` in several places in `packages/ui`**
CONTRIBUTING.md says "Always `type` over `interface` (except when methods needed)". Found 16 `interface` declarations in
UI layout components:
- `packages/ui/src/components/layout/app/eigen-app.tsx` line 16: `interface EigenAppProps`
- `packages/ui/src/components/layout/app/topbar.tsx` line 46: `interface TopbarProps`
- `packages/ui/src/components/layout/labels/label-provider.tsx` lines 6, 28
- `packages/ui/src/components/layout/labels/label-dialog.tsx` line 36
- `packages/ui/src/components/layout/drive/drive-create-folder-item.tsx` line 9
- `packages/ui/src/components/layout/drive/file-preview.tsx` line 10
- `packages/ui/src/components/layout/drive/drive-list.tsx` line 168
- `packages/ui/src/components/layout/shadow-content.tsx` line 4
- `packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx` line 5
- `packages/ui/src/components/layout/context-menu/context-menu-anchor.tsx` line 4
- `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` line 7
- `packages/ui/src/components/layout/braket/*.tsx`
- `packages/ui/src/components/layout/app/app-logo.tsx` line 9

None of these need methods. All should be `type`.

**15. Dead export map entries in `packages/lib/package.json`**
`"./admin": "./src/core/admin/index.ts"` -- the directory `packages/lib/src/core/admin/` does not exist.
`"./stickies": "./src/core/stickies/index.ts"` -- the directory `packages/lib/src/core/stickies/` does not exist.

These are phantom exports that will cause import resolution failures if any consumer tries to use them.

**16. `DriveLayoutProps.error` typed as `any`**
`packages/ui/src/components/layout/drive/drive-layout.tsx` line 29

```typescript
error: any;
```

Should use `Error | null` or a more specific type.

**17. `DriveLayoutProps.onAfterAction` data typed as `any`**
`packages/ui/src/components/layout/drive/drive-layout.tsx` line 35

```typescript
onAfterAction?: (actionType: string, data: any) => void;
```

Should have a discriminated union or at least a defined shape.

## Robustness

**Error handling in hooks is inconsistent.** Some hooks throw errors from API responses (e.g., `useCreateCalendar`
checks `if (response.error) throw new Error(...)`), while others silently return empty arrays or null (e.g.,
`useMounts`, `useRootFolder` just return `response.data || []`). When an API call fails with an error status, the
Eden Treaty response has `.error` set -- not checking it means the query succeeds with empty/null data, which is
indistinguishable from "no data yet."

Affected hooks that swallow errors silently:
- `useMounts` (line 33): returns `[]` on error
- `useRootFolder` (line 47): returns `null` on error
- `useMailboxes` (line 21): returns `[]` on error
- `useCalendars` (line 30): returns `[]` on error
- `useSharedCalendars` (line 181): returns `[]` on error
- `useHomeSize` (line 20): returns `null` on error
- `useContact` (line 41): returns `data` without error check

**Draft mutation hooks (`useUpdateDraft`, `useSendDraft`) catch errors and return `null` instead of throwing.**
`packages/lib/src/core/mail/hooks/use-draft.ts` lines 22-44. `updateDraftEmail` and `sendDraftEmail` catch all errors
and return `null`. Since `useMutation` relies on thrown errors to set `isError` state, consumers cannot distinguish
"draft saved but returned null" from "network failure." The error is logged to console but the mutation reports success.

**`MAIL_SENT` SSE event is a no-op.**
`packages/lib/src/core/mail/sse-handlers.ts` line 61. The handler matches `MAIL_SENT` but only returns `true` without
any cache invalidation. The sent message should at minimum invalidate the Sent mailbox list.

## Component Quality

**`UserAvatar` and `UserItem` have substantial code duplication.**
`packages/ui/src/components/layout/user-avatar.tsx` and `packages/ui/src/components/layout/user-item.tsx` both:
1. Call `useContacts()` to search contacts by email
2. Call `usePublicUser()` with the same lookup logic
3. Call `usePublicConfig()` and `usePeopleTeams()` for team name resolution
4. Compute `displayName` with the same fallback chain (team name > contact name > public name > name > email)
5. Compute `avatarSrc` with the same logic

This resolution logic should be extracted into a shared hook (e.g., `useResolvedUser(emailOrId)`), with `UserAvatar` and
`UserItem` consuming it.

**`UserAvatar` makes 4 API queries on every render.**
Each `UserAvatar` instance triggers: `useContacts()`, `usePublicUser()`, `usePublicConfig()`, `usePeopleTeams()`. In a
list of 20 users this means `useContacts` runs 20 times (though TanStack Query deduplicates). Still, calling the full
contacts list just to resolve one avatar is heavy. A dedicated endpoint or a lighter hook would be better.

**`UserItem` shows a loading spinner (`EigenLoader`) while fetching user data.**
`packages/ui/src/components/layout/user-item.tsx` line 52. In a list of users, each `UserItem` shows its own spinner
until both `usePublicUser` and `useContacts` resolve. This creates a flickering effect. `UserAvatar` does not have this
guard, which means they behave inconsistently.

**`SidebarContainer` has a z-index layering issue on mobile.**
`packages/ui/src/components/layout/sidebar/sidebar-container.tsx` lines 26-33 and 35-39. The sidebar content div uses
`z-50` while the backdrop overlay uses `z-40`. Since the backdrop is rendered after the sidebar content in the DOM, on
mobile the backdrop will appear above the sidebar content in some browsers. The backdrop should have a lower z-index
than the sidebar, or the sidebar should be rendered after the backdrop.

## Hook Quality

**Query key patterns are consistent within domains but inconsistent across domains.** Each domain defines its own key
factory (good), but the structures vary:

| Domain    | Root key      | Includes ownerId in keys? | Key factory location                                |
|-----------|---------------|---------------------------|-----------------------------------------------------|
| drive     | `['drive']`   | Only in `root()` key       | `use-drive.ts` (same file as hooks)                 |
| mail      | `['emails']`  | No                         | `use-emails.ts` (same file)                         |
| mailbox   | `['mailboxes']` | No                       | `use-mailboxes.ts` (same file)                      |
| contacts  | `['contacts']` | No                        | `use-contacts.ts` (same file)                       |
| labels    | `['labels']`  | No                         | `use-labels.ts` (same file)                         |
| calendar  | `['calendar']` | Only in `calendarEvents()` | `use-calendar.ts` (same file)                      |
| chat      | `['chat']`    | Yes (in `messages()`)      | `use-chat.ts` (same file)                           |
| home      | `['home']`    | No                         | `use-home.ts` (same file)                           |
| people    | `['people']`  | No                         | `keys.ts` (separate file, good)                     |
| public    | `['publicUser']` / `['publicConfig']` | In detail key | `use-public.ts` (same file)      |
| collab    | `['collab']`  | Yes (in doc/revision keys) | `use-collab.ts` (same file)                         |
| settings  | `['settings']` | No                        | `use-server-settings.ts` (same file)                |
| team      | `['team']`    | Yes (in settings/mount)    | `use-team-settings.ts` (same file)                  |
| space     | `['space']`   | No                         | `use-space-settings.ts` (same file)                 |
| editor    | `['editor']`  | Yes (in content key)       | `use-file-content.ts` (same file)                   |

The inconsistency around `ownerId` inclusion is the main concern. Domains that are inherently per-user (mail, contacts,
home, space) get away with omitting it because they use `useAuth()` internally. But drive, which serves both personal
and team contexts, should include it.

**People hooks (`usePeopleMembers`, `usePeopleTeams`) keys don't include `organizationId`.**
`packages/lib/src/core/people/hooks/keys.ts`. The keys `['people', 'members']` and `['people', 'teams']` are the same
regardless of which organization is being queried. If the app ever supports viewing multiple orgs, this will cause cache
collisions. Low risk currently since there's typically one org, but it's a latent bug.

**Chat `useMessages` uses `refetchInterval: 5000` alongside SSE.**
`packages/lib/src/core/chat/hooks/use-chat.ts` line 34. Messages already get invalidated via SSE events
(`handleChatSSEvent`). The 5-second polling is redundant when SSE is connected and wastes bandwidth. Consider making the
polling conditional on SSE connection status, or removing it entirely.

**Mail hooks use `useAuth()` internally while drive hooks take `ownerId` as a parameter.**
This is an architectural inconsistency. Mail, contacts, calendar, and home hooks call `useAuth()` inside the hook to
get `ownerId`. Drive, chat, collab, and editor hooks take `ownerId` as a parameter. The parameter approach is more
flexible (works for team drives), but the inconsistency is confusing. Since drive already needs to support multi-owner
scenarios, the parameter approach is correct there. The other domains should either adopt the same pattern or the
difference should be documented.

## Recommendations

1. **Add `ownerId` to all drive query keys** -- this is the highest-impact change and prevents cross-owner cache
   poisoning when team drives are used.

2. **Fix the UUID regex** in `parseOwnerId()` -- change `[0-9a-fA-Z]` to `[0-9a-fA-F]`.

3. **Extract user resolution logic** from `UserAvatar` and `UserItem` into a shared `useResolvedUser(emailOrId)` hook
   that returns `{displayName, avatarSrc, email, isLoading}`.

4. **Address `as any` casts in calendar hooks** -- adjust the Elysia calendar route types so Eden Treaty generates
   correct nested path types. This is the biggest type safety gap in the frontend.

5. **Make error handling consistent** across all query hooks. Either check `response.error` and throw in all hooks, or
   document that some hooks intentionally swallow errors. The current mix is confusing.

6. **Remove `console.log` from SSE handler** (line 50 of `use-sse.ts`).

7. **Remove or update dead export entries** (`admin`, `stickies`) from `packages/lib/package.json`.

8. **Fix the Dutch comment** in `use-labels.ts` line 7.

9. **Replace `interface` with `type`** in the 16 identified locations in `packages/ui` to match the project style guide.

10. **Remove `"use client"` directives** from the 10 identified files -- they have no effect in a Vite project and add
    confusion.

11. **Fix the `MAIL_SENT` SSE handler** to invalidate the Sent mailbox.

12. **Consider making chat polling conditional** on SSE connection status to avoid redundant network requests.
