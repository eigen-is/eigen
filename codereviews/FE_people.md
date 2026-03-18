# Frontend Review: People App (Org/Team Admin)

**Scope:** `apps/people/`, related hooks in `packages/lib/src/core/people/`, `packages/lib/src/core/team/`,
`packages/lib/src/core/settings/`, calendar hooks used by team detail
**Reviewed:** 2026-03-18

## Critical Issues

1. **Keyboard navigation selects wrong member -- ID type mismatch between `activeId` and `getId`**
   `apps/people/src/components/people/members-list.tsx:79-83`

   `useKeyboardListNavigation` is configured with `activeId: activeMemberId` (the membership ID from the URL) and
   `getId: (m) => m.userId` (the user UUID). These are different identifiers. Consequently:
   - The hook's sync effect (line 37 in `use-keyboard-list-navigation.ts`) compares `activeId` against `getId(item)`
     and will never find a match, so keyboard highlight never syncs with the URL-selected member.
   - When the user presses arrow keys and `onSelect` fires, it passes `m.userId` to `onRowClick`, which navigates to
     `/members?memberId={userId}`. The detail pane then does `members.find(m => m.id === memberId)` using the
     membership ID field, which will not match the user UUID, so no detail is shown.

   In short, clicking a member works (uses `member.id`), but keyboard navigation is broken (uses `member.userId`).

   **Impact:** Keyboard-driven member selection shows empty detail pane.
   **Fix:** Use a consistent identifier. Either change `getId` to `(m) => m.id` throughout the list (selection, drag,
   keyboard), or change the URL param / detail lookup to use `userId`. The former is simpler since drag targets accept
   `userId` and would need separate handling.
   **Status:** New finding. The previous review noted the dual-ID pattern as "internally consistent but confusing"
   (former Minor #5) -- this deeper analysis reveals it is actually a functional bug.

2. **Team calendar save overwrites entire shares array, losing non-team shares**
   `apps/people/src/components/people/team-detail.tsx:250-253`

   ```typescript
   const shares = draftCalPermission === 'read'
       ? null
       : [{targetId: teamTarget, permission: draftCalPermission as 'free-busy' | 'write'}];
   await updateCalendar.mutateAsync({id: defaultCal.id, shares});
   ```

   When saving team settings, the calendar's `shares` field is replaced wholesale. If `draftCalPermission` is `read`,
   `null` is sent which clears all shares. If `free-busy` or `write`, a single-element array is sent. In both cases,
   any pre-existing shares on the team calendar (e.g., shares to individual users or other teams) are silently
   destroyed. The `UpdateCalendarInput.shares` type is `CalendarShare[] | null`, confirming this is a full
   replacement, not a merge.

   **Impact:** Saving team settings can silently remove calendar sharing with other entities.
   **Fix:** Read `defaultCal.shares`, filter out the current team's entry, then append the new team share (or omit it
   for `read`). Pass the merged array to `updateCalendar`.
   **Status:** New finding. Not identified in the previous review.

## Important Issues

1. **`as any` cast in team settings save hides `null` vs `undefined` type mismatch**
   `apps/people/src/components/people/team-detail.tsx:242-248`

   The `TeamSettings` type defines `memberOverrides` fields as `number | undefined`, but the save sends `null` to
   mean "inherit from server default". The `as any` cast silences this. Whether the backend handles `null` correctly
   depends on the JSON store implementation -- if it stores `null` literally, downstream `resolveUserQuotas()` may
   treat `null` as a defined value rather than absent.

   **Impact:** Potential incorrect quota resolution for teams with cleared overrides.
   **Fix:** Either update the `TeamSettings` type to accept `number | null` for override fields, or send `undefined`
   instead of `null`.
   **Status:** Carried from previous review (former Important #1). Confirmed type mismatch still present.

2. **Multiple `as any` casts in shared hooks weaken type safety for all consumers**
   Locations:
   - `packages/lib/src/core/people/hooks/use-members.ts:35` -- `role: role as any`
   - `packages/lib/src/core/people/hooks/use-members.ts:77` -- `role: role as any`
   - `packages/lib/src/core/team/hooks/use-team-mounts.ts:27` -- `body as any`
   - `packages/lib/src/core/team/hooks/use-team-mounts.ts:40` -- `body as any`
   - `packages/lib/src/core/settings/hooks/use-server-settings.ts:26` -- `body as any`
   - `packages/lib/src/core/settings/hooks/use-s3-config.ts:26` -- `body as any`
   - `packages/lib/src/core/calendar/hooks/use-calendar.ts:56` -- `(calendarApi(...) as any)(...).put(data as any)`

   These are in the shared hook layer, so every consumer inherits the type erasure. The role casts are particularly
   concerning since `role: string` from the form could be any string, bypassing better-auth's role validation.

   **Impact:** Type errors in API payloads are invisible at compile time.
   **Fix:** For roles, define `type OrgRole = 'owner' | 'admin' | 'member'` in `types/people.ts` and use it in the
   form state and hook parameter. For Eden Treaty body mismatches, investigate whether the generated types can be
   aligned or create explicit input types.
   **Status:** Carried from previous review (former Important #2). Unchanged.

3. **Server settings quota inputs accept NaN, negatives, and logically invalid values**
   `apps/people/src/components/people/server-settings.tsx:56-58,136-167`

   The `updateQuota` function passes `e.target.valueAsNumber` directly into state, which is `NaN` when the input is
   cleared. `<Input type="number" min={10}>` does not prevent typing negatives or clearing. The backend validates
   with `t.Number({minimum: 10})`, so invalid values cause a server rejection with a generic error toast rather
   than inline feedback. Additionally, nothing prevents `maxUploadSizeMB` from exceeding `maxBatchUploadSizeMB`.

   **Impact:** Poor UX -- users can enter invalid values and get unhelpful error messages.
   **Fix:** Add client-side validation: guard against `NaN` in `updateQuota` (e.g., `if (isNaN(value)) return`),
   add cross-field validation before save, and show inline error states.
   **Status:** Carried from previous review (former Important #3). Confirmed backend guards exist but UX gap remains.

4. **Team detail quota override inputs can send NaN to API**
   `apps/people/src/components/people/team-detail.tsx:245-246,359-366`

   Draft values are stored as strings and converted with `Number()` at save time. While `draftMailMax ? ... : null`
   handles empty strings, a user typing non-numeric characters (possible via paste) would produce
   `Number('abc') === NaN`, which would be sent to the API.

   **Impact:** API error with unhelpful message on malformed input.
   **Fix:** Validate converted values before saving. Check `isNaN()` and show feedback.
   **Status:** Carried from previous review (former Important #4). Unchanged.

5. **`location.search.teamId` accessed on untyped search at root level**
   `apps/people/src/routes/__root.tsx:20`

   ```typescript
   const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;
   ```

   At the root route level, `location.search` is the union of all route search schemas. While this works at runtime
   because `teamId` is simply `undefined` on non-teams routes, it bypasses the typed search validation. If TanStack
   Router's type strictness increases, this could break.

   **Impact:** Low risk currently, but fragile pattern.
   **Fix:** Use `typeof location.search === 'object' && 'teamId' in location.search && location.search.teamId`
   or extract this logic into the teams route itself.
   **Status:** Carried from previous review (former Important #5). Unchanged.

6. **S3 config and server settings are saved independently with no cross-validation**
   `apps/people/src/components/people/server-settings.tsx`

   A user can set `storageType = 's3'` and save server settings without configuring S3 credentials. New mounts would
   then default to S3 with no working backend. There is no warning or blocking validation.

   **Impact:** Admin could put the server in a broken state where new mounts fail.
   **Fix:** When saving server settings with `storageType = 's3'`, check if S3 config exists (either saved or in
   the current draft). Show a warning if not.
   **Status:** Carried from previous review (former Important #6). Unchanged.

7. **Auth guard rejects non-admin users in the component tree, not in route `beforeLoad`**
   `apps/people/src/routes/_auth.tsx:22-64`

   The `_auth.tsx` route's `beforeLoad` only checks authentication (redirects to `/login`). The admin/owner role
   check happens in the `AuthGuard` component body (line 53), which means the full `AuthGuard` component mounts,
   fetches `usePublicConfig` and `usePeopleMembers`, and renders a loading spinner before finally showing "Access
   Denied". A non-admin user triggers two data fetches they should not need.

   **Impact:** Unnecessary API calls for non-admin users; brief loading flash before access denial.
   **Fix:** Move the role check into `beforeLoad` by having the router context include the user's org role, or
   at minimum skip the members fetch when the role is already known.
   **Status:** New finding.

## Minor Issues

1. **`interface` used where `type` is preferred (7 instances in non-generated files)**
   - `apps/people/src/routes/__root.tsx:9` -- `interface MyRouterContext`
   - `apps/people/src/components/people/members-list.tsx:14` -- `interface MembersListToolbarProps`
   - `apps/people/src/components/people/members-list.tsx:56` -- `interface MembersListProps`
   - `apps/people/src/components/people/member-detail.tsx:13` -- `interface MemberDetailToolbarProps`
   - `apps/people/src/components/people/member-detail.tsx:49` -- `interface MemberDetailProps`
   - `apps/people/src/components/people/people-sidebar.tsx:19` -- `interface PeopleSidebarProps`
   - `apps/people/src/components/people/create-user-dialog.tsx:12` -- `interface CreateUserDialogProps`

   Project convention (CONTRIBUTING.md) specifies `type` over `interface` except when methods are needed. None of
   these have methods.

   **Impact:** Style inconsistency. `team-detail.tsx` already correctly uses `type` for its props.
   **Fix:** Replace `interface` with `type` in these files.
   **Status:** Carried from previous review (former Minor #1). Count corrected from 8 to 7.

2. **CreateUserDialog does not reset form state on cancel**
   `apps/people/src/components/people/create-user-dialog.tsx:98`

   The cancel button calls `onOpenChange(false)` but does not clear `name`, `username`, `password`, `role`. If a
   user partially fills the form, cancels, and reopens, stale values persist. Reset only happens on successful
   creation (lines 34-38).

   **Impact:** Minor UX issue -- stale form data on reopen.
   **Fix:** Add a reset function and call it in the `onOpenChange` handler when closing, or use a key prop to
   remount on open.
   **Status:** Carried from previous review (former Minor #2). Unchanged.

3. **Team sidebar links use manual URL construction instead of typed search params**
   `apps/people/src/components/people/people-sidebar.tsx:97`

   ```typescript
   to={`/teams?teamId=${team.id}`}
   ```

   Builds URL as a string template, bypassing TanStack Router's typed `search` parameter. Should use
   `to="/teams" search={{teamId: team.id}}` for type safety and consistency.

   **Impact:** No type checking on the search param name or value.
   **Fix:** Use TanStack Router's `search` prop.
   **Status:** Carried from previous review (former Minor #3). Unchanged.

4. **`organizationId` prop accepted but unused in `CreateUserDialog`**
   `apps/people/src/components/people/create-user-dialog.tsx:15,18`

   The `CreateUserDialogProps` type declares `organizationId?: string` and the component destructures it, but never
   references it. The `useCreateUser` hook does not take an `organizationId`. The prop is passed from
   `MembersListToolbar` at `_auth.members.tsx:54`.

   **Impact:** Dead code; misleading API surface.
   **Fix:** Remove the prop from the type, destructuring, and call site.
   **Status:** Carried from previous review (former Minor #4). Unchanged.

5. **Create team dialog in sidebar does not reset name on cancel**
   `apps/people/src/components/people/people-sidebar.tsx:108-129`

   The create team dialog's cancel button calls `setShowCreate(false)` but `newTeamName` is only reset on
   successful creation (line 45). If the user types a name and cancels, the old text remains when reopening.

   **Impact:** Minor UX issue -- stale team name on reopen.
   **Fix:** Reset `newTeamName` in the `onOpenChange` handler or when showing the dialog.
   **Status:** New finding.

6. **No confirmation dialog for removing team members**
   `apps/people/src/components/people/team-detail.tsx:497-504`

   The X button on each team member row calls `handleRemoveMember` immediately, unlike team deletion
   (`DeleteDialog` at line 60) and org member removal (`DeleteDialog` at line 38 of `member-detail.tsx`). This is
   inconsistent and makes accidental removal easy.

   **Impact:** Accidental member removal with no undo.
   **Fix:** Add a `DeleteDialog` or at minimum a toast with undo, matching the pattern used elsewhere.
   **Status:** Carried from previous review (former Minor #7). Unchanged.

7. **TeamDetail is 513 lines with four components in one file**
   `apps/people/src/components/people/team-detail.tsx`

   Contains `TeamDetailToolbar`, `AddMemberDialog`, `MountDialog`, and `TeamDetail`. The main `TeamDetail` alone
   is over 300 lines with extensive mount, member, calendar, and settings management.

   **Impact:** Harder to navigate and maintain.
   **Fix:** Extract `AddMemberDialog` and `MountDialog` into separate files. The settings form could also become
   a sub-component.
   **Status:** Carried from previous review (former Minor #6). Unchanged.

8. **`teamMembers` data uses inline type annotation instead of shared type**
   `apps/people/src/components/people/team-detail.tsx:217,487`

   ```typescript
   teamMembers.map((tm: {userId: string}) => m.userId)
   ```

   The `useTeamMembers` hook returns `data ?? []` without a typed return, so the component annotates team member
   objects inline as `{userId: string}`. This is fragile and loses other fields the API returns.

   **Impact:** If the team member shape changes, these inline annotations silently suppress type errors.
   **Fix:** Add a `TeamMember` type to `types/people.ts` and use it as the return type of `useTeamMembers`.
   **Status:** New finding.

9. **No SSE events for org member or team membership changes**
   `packages/lib/src/core/team/sse-handlers.ts`

   The only team-related SSE event is `TEAM_SETTINGS_UPDATED`. There are no events for member added/removed,
   team created/deleted, or org member role changed. If two admins manage the org simultaneously, changes by one
   are invisible to the other until a manual refresh or the 2-minute stale time expires.

   **Impact:** Stale UI during concurrent admin operations.
   **Fix:** Add SSE events for member/team CRUD operations and corresponding invalidation handlers in the SSE
   handler. Alternatively, reduce `staleTime` on people queries.
   **Status:** New finding.

10. **`handleAddMembersToTeam` in root silently stops on first error without reporting partial success**
    `apps/people/src/routes/__root.tsx:22-33`

    The drag-and-drop handler loops through `memberIds` and calls `addMember.mutateAsync` sequentially. On error,
    it shows an error toast and returns, but does not report how many of the members were successfully added before
    the failure.

    **Impact:** User sees an error but does not know which members were added.
    **Fix:** Track success count and report "Added N of M members" in the error case, or batch the operation.
    **Status:** New finding.

## Observations

- The People app correctly delegates all data fetching to shared hooks in `packages/lib/`. No direct
  `useQuery`/`useMutation` calls exist in app code.
- The `EigenApp` provider stack (in `packages/ui`) provides SSE connectivity, but the People app does not benefit
  much from it since org/team membership events are not SSE-driven.
- The `_auth.tsx` guard uses `authClient.organization.setActive()` with a `useRef` to prevent re-firing, which is
  a reasonable approach for ensuring the org context is set once.
- Mount management (add, edit, enable/disable) in team detail is well-implemented with proper `MountForm` reuse
  from the shared UI library.
- The drag-and-drop member assignment to teams via `DroppableSidebarItem` is a nice interaction pattern.
- Query key hierarchy is clean: `peopleKeys` for members/teams, `teamKeys` for team-level settings/mounts,
  `settingsKeys` for server-wide config. Invalidation scopes are appropriately narrow.
- The `mapStorageType` function in `types/settings.ts` correctly maps between the server-level storage type names
  (`local-id`, `local-fullnames`) and the mount-level names (`local-key`, `local`).
