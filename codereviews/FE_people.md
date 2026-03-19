# Frontend Review: People App (Org/Team Admin)

**Scope:** `apps/people/`, related hooks in `packages/lib/src/core/people/`,
`packages/lib/src/core/team/`, `packages/lib/src/core/settings/`, calendar hooks used by team detail
**Reviewed:** 2026-03-19

## Architecture Overview

The People app is the admin UI for managing org members, teams, and server-wide settings. It lives at
`apps/people/` and is mounted under the `/people` base path. The app has four authenticated routes:

| Route       | Component              | Purpose                                               |
|-------------|------------------------|-------------------------------------------------------|
| `/members`  | `MembersRoute`         | ColumnLayout list/detail for org members              |
| `/teams`    | `TeamsRoute`           | Single-column team detail (team selected via sidebar) |
| `/settings` | `SettingsRoute`        | Server-wide quota and storage settings                |
| `/login`    | Standard login page    | Shared login route                                    |
| `/`         | Redirect to `/members` | Entry point                                           |

**Auth guard** (`_auth.tsx`): Checks authentication in `beforeLoad`, then checks admin/owner role in the
component body. Non-admin users see an "Access Denied" message after a loading phase.

**Data layer**: All data hooks live in `packages/lib/src/core/people/hooks/` (members, teams) and
`packages/lib/src/core/team/hooks/` (team settings, mounts). The hooks use `authClient.organization.*`
(better-auth) for member/team CRUD and Eden Treaty `teamApi`/`settingsApi` for settings. No `useQuery` or
`useMutation` calls exist directly in app code -- the pattern is followed correctly.

**Sidebar**: The `PeopleSidebar` shows three nav items (Members, Teams, Settings) and a dynamic list of
teams with drag-drop support for assigning members. Team creation is done via an inline dialog in the
sidebar.

**Team detail** (`team-detail.tsx`): The most complex component at 514 lines. Manages team name, calendar
toggle and permission, quota overrides, mounts (add/edit/enable/disable), and members (add/remove). The
settings section is a toggled inline form.

## Critical Issues

### 1. Keyboard navigation selects wrong member -- ID type mismatch between `activeId` and `getId`

`apps/people/src/components/people/members-list.tsx:79-83`

```typescript
const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
    items: filteredMembers,
    activeId: activeMemberId,       // membership ID (e.g., "mem_abc123")
    getId: (m) => m.id,             // also membership ID -- BUT...
    onSelect: (id) => onRowClick(id),
    containerRef: listRef,
    selection,                      // selection uses m.userId!
});
```

The `useKeyboardListNavigation` hook uses `getId: (m) => m.id` (the membership ID), while
`useListSelection` at line 75 uses `getId: (m) => m.userId` (the user UUID). These are different
identifiers on the same items.

When the user navigates with arrow keys, the `updateSelection` function inside the keyboard hook calls
`selection.select(getId(item))` -- this passes the membership ID (`m.id`) to the selection system which
operates on user IDs (`m.userId`). The selection highlight (`selection.isSelected(member.userId)` at
line 109) will therefore never match the keyboard-navigated item.

Similarly, `useListDrag` at line 77 uses `getId: (m) => m.userId`, so selection-based drag uses user
IDs while keyboard navigation feeds membership IDs into the selection. This causes keyboard-selected
items to not appear selected and not be draggable.

The keyboard `onSelect` callback itself works correctly (it passes `m.id` to `onRowClick` which
navigates to `?memberId={id}`, and the detail pane resolves via `members.find(m => m.id === memberId)`)
-- so Enter/arrow navigation does show the correct detail. But the visual selection state is broken.

**Impact:** Keyboard-navigated member is not visually selected; keyboard selection does not integrate
with multi-select or drag-and-drop.

**Fix:** Use a single consistent ID function across all three hooks. Either change `useListSelection`
and `useListDrag` to use `(m) => m.id`, or change `useKeyboardListNavigation` to use `(m) => m.userId`
and adjust `onRowClick`/`activeMemberId` to use user IDs throughout. The cleanest approach is to use
`m.id` everywhere since that is what the URL and detail pane use, and adjust drag to pass `m.id`
(updating `DroppableSidebarItem.onDrop` and `handleAddMembersToTeam` to accept membership IDs instead
of user IDs).

### 2. `handleSaveSettings` does not update calendar shares when calendar is being disabled

`apps/people/src/components/people/team-detail.tsx:249-255`

```typescript
if (defaultCal && draftCalEnabled) {
    const existingShares = (defaultCal.shares || []).filter(s => s.targetId !== teamTarget);
    const shares = draftCalPermission === 'read'
        ? (existingShares.length > 0 ? existingShares : null)
        : [...existingShares, {targetId: teamTarget, permission: draftCalPermission as 'free-busy' | 'write'}];
    await updateCalendar.mutateAsync({id: defaultCal.id, shares});
}
```

The `if (defaultCal && draftCalEnabled)` guard means the calendar share update is skipped when the admin
disables the calendar. If the calendar previously had `write` or `free-busy` permission set as a share
entry, that share entry remains in the database even though the calendar is marked disabled. If the
calendar is later re-enabled with the intent to set it to `read` (no share entry), the stale share from
the previous configuration persists and grants a higher permission than intended.

**Impact:** Disabling and re-enabling a team calendar can silently preserve elevated permissions from
before the disable.

**Fix:** When `draftCalEnabled` is false, also update the calendar to remove the team's share entry:

```typescript
if (defaultCal) {
    if (draftCalEnabled) {
        // existing logic
    } else {
        const existingShares = (defaultCal.shares || []).filter(s => s.targetId !== teamTarget);
        await updateCalendar.mutateAsync({id: defaultCal.id, shares: existingShares.length > 0 ? existingShares : null});
    }
}
```

## Important Issues

### 1. Server settings quota inputs accept zero and values below minimum

`apps/people/src/components/people/server-settings.tsx:62-66`

```typescript
const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
    if (isNaN(value) || value < 0) return;
    setDirty(true);
    setDraft(prev => ({...prev, quotas: {...prev.quotas, [key]: value}}));
};
```

The guard rejects NaN and negative values, but accepts `0`. The HTML inputs have `min={10}` or `min={1}`
attributes, but these only affect the spinner buttons, not typed input. A user can type `0` (or `5` for
a field with `min={10}`) and the value is accepted into state. The backend validates `minimum: 10`, so
the save will fail with a generic error toast.

Additionally, the guard silently ignores NaN, which occurs when the user clears the input field. The
input appears empty but the draft state retains the old value, creating a disconnect between what the
user sees and what will be saved.

There is also no cross-field validation: `maxUploadSizeMB` can be set higher than `maxBatchUploadSizeMB`,
which is logically inconsistent.

**Impact:** Poor UX -- users can enter invalid values and get unhelpful error messages on save.
**Fix:** Match the client-side guard to the server minimums (e.g., `value < 10` for quota fields,
`value < 1` for upload fields). Handle the cleared-input case by either allowing empty (map to server
default) or showing inline validation. Add cross-field checks before save.

### 2. Team detail quota override inputs can send NaN to API

`apps/people/src/components/people/team-detail.tsx:245-246`

```typescript
mailAndContactsMaxMB: draftMailMax ? Number(draftMailMax) : undefined,
defaultMountMaxSizeMB: draftMountMax ? Number(draftMountMax) : undefined,
```

Draft values are stored as strings and converted with `Number()` at save time. While
`draftMailMax ? ... : undefined` handles empty strings, a user pasting non-numeric characters produces
`Number('abc') === NaN`, which passes the truthiness check (non-empty string) and sends `NaN` to the
API. The `<Input type="number">` helps prevent this on desktop browsers but is not universally enforced
(e.g., paste events, mobile keyboards).

**Impact:** API error with unhelpful message on malformed input.
**Fix:** Validate the converted values before saving: `const val = Number(draftMailMax);
if (draftMailMax && (isNaN(val) || val < 10)) { toast.error(...); return; }`.

### 3. Auth guard checks role in component body, not in route `beforeLoad`

`apps/people/src/routes/_auth.tsx:9-17,22-64`

The `beforeLoad` hook only checks `context.auth.isAuthenticated` and redirects to login if not. The
admin/owner role check happens in the `AuthGuard` component (line 53), which means the full component
mounts, fetches `usePublicConfig` and `usePeopleMembers`, and renders a loading spinner before finally
showing "Access Denied". A non-admin user triggers two unnecessary API calls.

**Impact:** Unnecessary data fetching for non-admin users; brief loading flash before denial.
**Fix:** Ideally move the role check into `beforeLoad` by including org role in the router context, or
at minimum, check the session's active organization role before fetching member data.

### 4. `location.search.teamId` accessed on untyped search at root level

`apps/people/src/routes/__root.tsx:20`

```typescript
const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;
```

At the root route, `location.search` is the union of all route search schemas. This works at runtime
because `teamId` is simply `undefined` on non-teams routes, but it bypasses typed search validation.
If TanStack Router tightens its type strictness in a future version, this could break at compile time.

**Impact:** Low risk currently, but fragile pattern.
**Fix:** Use `useMatches()` to check if the teams route is active and extract its search params, or
move the sidebar mode logic to the teams route itself.

### 5. S3 config and server settings saved independently with no cross-validation

`apps/people/src/components/people/server-settings.tsx`

A user can set `storageType = 's3'` and save server settings without configuring S3 credentials first.
New mounts would then default to S3 with no working backend. There is no warning or blocking validation
linking the two forms.

**Impact:** Admin could put the server in a broken state where new mount creation fails.
**Fix:** When saving server settings with `storageType = 's3'`, check if S3 config exists (either saved
or in the current draft). Show a warning or block the save if S3 is not configured.

### 6. `SettingsDraft` sent to API with `as Record<string, unknown>` type erasure

`apps/people/src/components/people/server-settings.tsx:75`

```typescript
await updateSettings.mutateAsync(draft as Record<string, unknown>);
```

The `SettingsDraft` type uses `Partial<ServerSettings['quotas']>` for nested fields, which is
structurally different from `Partial<ServerSettings>` (the hook's parameter type). Instead of fixing the
type alignment, the code casts to `Record<string, unknown>`. This silently bypasses compile-time
checking of the payload shape.

**Impact:** If `ServerSettings` changes (e.g., renaming `quotas` to `limits`), the draft construction
will not get a type error.
**Fix:** Align `SettingsDraft` with `Partial<ServerSettings>` or use
`DeepPartial<ServerSettings>` as the hook parameter type, removing the need for the cast.

### 7. `handleAddMembersToTeam` stops on first error without reporting partial success

`apps/people/src/routes/__root.tsx:22-33`

```typescript
const handleAddMembersToTeam = async (memberIds: string[], teamId: string) => {
    const team = teams.find(t => t.id === teamId);
    for (const userId of memberIds) {
        try {
            await addMember.mutateAsync({teamId, userId});
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to add member to team');
            return;
        }
    }
    toast.success(`Added ${memberIds.length} member${memberIds.length > 1 ? 's' : ''} to ${team?.name ?? 'team'}`);
};
```

When multiple members are drag-dropped onto a team, the handler adds them sequentially. If one fails,
it shows an error toast and returns immediately, but does not indicate how many were successfully added
before the failure. The success toast (claiming all N members added) is never shown.

**Impact:** User sees an error but does not know the true state of the operation.
**Fix:** Track the success count and show a combined message like "Added N of M members; failed on
{name}".

## Minor Issues

### 1. `interface` used where `type` is preferred (7 instances)

Project convention (CONTRIBUTING.md) specifies `type` over `interface` except when methods are needed.
Seven non-generated files use `interface` for simple props types:

- `apps/people/src/routes/__root.tsx:9` -- `interface MyRouterContext`
- `apps/people/src/components/people/members-list.tsx:14` -- `interface MembersListToolbarProps`
- `apps/people/src/components/people/members-list.tsx:56` -- `interface MembersListProps`
- `apps/people/src/components/people/member-detail.tsx:13` -- `interface MemberDetailToolbarProps`
- `apps/people/src/components/people/member-detail.tsx:49` -- `interface MemberDetailProps`
- `apps/people/src/components/people/people-sidebar.tsx:19` -- `interface PeopleSidebarProps`
- `apps/people/src/components/people/create-user-dialog.tsx:12` -- `interface CreateUserDialogProps`

`team-detail.tsx` correctly uses `type` for all its props definitions.

**Fix:** Replace `interface` with `type` and `=` syntax in these files.

### 2. CreateUserDialog does not reset form state on cancel/close

`apps/people/src/components/people/create-user-dialog.tsx:98`

The cancel button calls `onOpenChange(false)` but does not clear `name`, `username`, `password`, `role`.
If a user partially fills the form, cancels, and reopens, stale values persist. Reset only happens on
successful creation (lines 34-38).

**Fix:** Reset state in the `onOpenChange` handler when closing, or use a `key` prop tied to the open
state to remount the form.

### 3. Create team dialog does not reset name on cancel

`apps/people/src/components/people/people-sidebar.tsx:108-129`

Same pattern: the `onOpenChange` callback at line 108 does not reset `newTeamName`. The reset at line 45
only fires on success. Stale text persists if the user cancels and reopens.

**Fix:** Add `setNewTeamName('')` to the `onOpenChange` handler when the dialog closes.

### 4. Team sidebar links use manual URL construction instead of typed search params

`apps/people/src/components/people/people-sidebar.tsx:97`

```typescript
to={`/teams?teamId=${team.id}`}
```

Builds the URL as a string template, bypassing TanStack Router's typed `search` parameter. Should use
`to="/teams" search={{teamId: team.id}}` for type safety and consistency with other route navigation in
the app (e.g., `members-list.tsx` uses `navigate({to: '/members', search: {memberId: id}})`).

**Fix:** Use TanStack Router's `search` prop on `DroppableSidebarItem`.

### 5. `organizationId` prop accepted but unused in `CreateUserDialog`

`apps/people/src/components/people/create-user-dialog.tsx:15,18`

The `CreateUserDialogProps` type declares `organizationId?: string` and the component accepts it in the
destructuring, but never references it. The `useCreateUser` hook does not take an `organizationId`.

**Fix:** Remove the prop from the type, destructuring, and the call site at
`_auth.members.tsx:54`.

### 6. No confirmation dialog for removing team members

`apps/people/src/components/people/team-detail.tsx:497-504`

The X button on each team member row calls `handleRemoveMember` directly with no confirmation, unlike
team deletion (uses `DeleteDialog` at line 60) and org member removal (uses `DeleteDialog` at line 38
of `member-detail.tsx`). This is inconsistent and makes accidental removal easy.

**Fix:** Add a `DeleteDialog` or at minimum a confirmation prompt, matching the pattern used elsewhere
in the app.

### 7. `TeamDetail` is 514 lines with four components in one file

`apps/people/src/components/people/team-detail.tsx`

Contains `TeamDetailToolbar`, `AddMemberDialog`, `MountDialog`, and `TeamDetail`. The main component
manages mounts, members, calendar settings, and quota overrides -- four distinct concerns.

**Fix:** Extract `AddMemberDialog` and `MountDialog` into separate files. Consider splitting the
settings form into a `TeamSettingsForm` sub-component.

### 8. Team member data uses inline type annotation instead of shared type

`apps/people/src/components/people/team-detail.tsx:217,488`

```typescript
teamMembers.map((tm: {userId: string}) => m.userId)
```

The `useTeamMembers` hook returns `data ?? []` without a strongly typed return. The component annotates
team member objects inline as `{userId: string}`, which is fragile and loses other fields the API
returns.

**Fix:** Add a `TeamMember` type to `types/people.ts` and use it as the return type of
`useTeamMembers`.

### 9. No SSE events for org member or team membership changes

`packages/lib/src/core/team/sse-handlers.ts`

The only team-related SSE event is `TEAM_SETTINGS_UPDATED`. There are no events for:

- Member added/removed from org
- Member added/removed from team
- Team created/deleted
- Org member role changed

If two admins manage the org simultaneously, changes by one are invisible to the other until the 2-minute
`staleTime` expires or the page is manually refreshed.

**Fix:** Add SSE events for team/member CRUD and corresponding invalidation handlers. Alternatively,
reduce `staleTime` on people queries for admin views.

### 10. Teams route `ColumnLayout` missing `mobileColumn` prop

`apps/people/src/routes/_auth.teams.tsx:40`

```typescript
<ColumnLayout>
    <Column id="detail" width="flex" toolbar={detailToolbar}>
```

The `ColumnLayout` does not set `mobileColumn`. Per the layout system docs, `mobileColumn` determines
which column is visible on mobile. With a single column this is likely fine (the column shows by
default), but it is inconsistent with the members route which correctly sets
`mobileColumn={memberId ? 'detail' : 'list'}`.

**Fix:** Add `mobileColumn="detail"` for explicitness, or consider adding a list column for mobile
team selection.

## Strengths

- **Clean separation of concerns in the data layer.** All data fetching is in shared hooks
  (`packages/lib/src/core/people/hooks/`, `packages/lib/src/core/team/hooks/`). The app components
  contain zero direct `useQuery`/`useMutation` calls. This makes the hooks reusable across apps.

- **Proper error handling on mutations.** Every mutation call is wrapped in try/catch with
  `toast.error()`. No fire-and-forget async calls were found.

- **Query key hierarchy is well-designed.** `peopleKeys` for members/teams, `teamKeys` for team-level
  settings/mounts, `settingsKeys` for server-wide config. Invalidation scopes are appropriately narrow
  (e.g., `teamMembers(teamId)` invalidates only that team's member list).

- **Drag-and-drop member assignment.** The `DroppableSidebarItem` pattern for dragging members to teams
  is a thoughtful interaction that leverages the shared list selection and drag infrastructure.

- **Mount management reuses shared `MountForm` component.** Add and edit mount dialogs both delegate to
  the shared `MountForm` from `packages/ui`, ensuring consistent form behavior with the rest of the
  platform.

- **Calendar share preservation.** The `handleSaveSettings` function correctly preserves non-team shares
  when updating the team's calendar permission (line 250: filters out only the current team's entry,
  then merges).

- **`mapStorageType` bridges server vs mount naming.** The utility correctly maps between server-level
  storage type names (`local-id`, `local-fullnames`) and mount-level names (`local-key`, `local`),
  preventing a common source of confusion.

- **Consistent loading and empty states.** All routes show `EigenLoader` during data loading and
  descriptive placeholder text when no item is selected.

- **No `as any` casts in app code or shared hooks.** The people hooks, team hooks, and settings hooks
  are all free of `as any` casts. The only `as any` occurrences are in the auto-generated
  `routeTree.gen.ts`, which is expected TanStack Router behavior.

## Coverage Analysis

| Area                     | Status   | Notes                                                      |
|--------------------------|----------|------------------------------------------------------------|
| Org member list + search | Good     | Filtering, keyboard nav (with ID bug), drag support        |
| Org member detail + role | Good     | Role change, removal with confirmation                     |
| User creation            | Good     | Form with validation, domain auto-append                   |
| Team creation            | Good     | Sidebar dialog with error handling                         |
| Team deletion            | Good     | Confirmation dialog                                        |
| Team member management   | Partial  | Add works, remove lacks confirmation                       |
| Team calendar settings   | Good     | Enable/disable, permission levels, share preservation      |
| Team quota overrides     | Partial  | Works but NaN guard missing                                |
| Team mount management    | Good     | Add, edit, enable/disable with shared MountForm            |
| Server quota settings    | Partial  | Backend validates but client-side UX gaps                  |
| Server storage type + S3 | Partial  | No cross-validation between storage type and S3 config     |
| Auth guard               | Adequate | Works but fetches data before denying non-admins           |
| SSE / real-time updates  | Minimal  | Only `TEAM_SETTINGS_UPDATED`; no member/team events        |
| Mobile responsiveness    | Adequate | Members route handles it; teams route missing mobileColumn |

## Key Files

| File                                                       | Purpose                                                 |
|------------------------------------------------------------|---------------------------------------------------------|
| `apps/people/src/routes/__root.tsx`                        | Root layout, sidebar, drag-drop handler                 |
| `apps/people/src/routes/_auth.tsx`                         | Auth + admin role guard                                 |
| `apps/people/src/routes/_auth.members.tsx`                 | Members list/detail route                               |
| `apps/people/src/routes/_auth.teams.tsx`                   | Teams route                                             |
| `apps/people/src/routes/_auth.settings.tsx`                | Server settings route                                   |
| `apps/people/src/components/people/members-list.tsx`       | Member list with keyboard nav + drag                    |
| `apps/people/src/components/people/member-detail.tsx`      | Member detail + role management                         |
| `apps/people/src/components/people/team-detail.tsx`        | Team management (members, calendar, mounts, settings)   |
| `apps/people/src/components/people/create-user-dialog.tsx` | New user creation form                                  |
| `apps/people/src/components/people/server-settings.tsx`    | Server-wide quotas + S3 config                          |
| `apps/people/src/components/people/people-sidebar.tsx`     | Sidebar with team list + create dialog                  |
| `packages/lib/src/core/people/hooks/use-members.ts`        | Org member CRUD hooks                                   |
| `packages/lib/src/core/people/hooks/use-teams.ts`          | Team CRUD + member management hooks                     |
| `packages/lib/src/core/people/hooks/keys.ts`               | Query key definitions                                   |
| `packages/lib/src/core/team/hooks/use-team-settings.ts`    | Team settings read/write hooks                          |
| `packages/lib/src/core/team/hooks/use-team-mounts.ts`      | Team mount management hooks                             |
| `packages/lib/src/core/team/sse-handlers.ts`               | SSE event handler (settings only)                       |
| `packages/lib/src/types/people.ts`                         | `OrgMember`, `OrgTeam` types                            |
| `packages/lib/src/types/settings.ts`                       | `TeamSettings`, `ServerSettings`, `MountSettings` types |
| `docs/PEOPLE.md`                                           | App documentation                                       |
| `docs/ORGANISATIONS-AND-TEAMS.md`                          | Org/team architecture docs                              |
