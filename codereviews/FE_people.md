# Frontend Code Review: People App (Admin, Teams, Settings)

## Summary

The People app is the admin UI for organization management: members list/CRUD, teams with drag-and-drop member
assignment, team calendar and quota settings, mount management, and server-wide settings (quotas, storage type, S3
configuration). It is the most complex of the four admin apps with 15 source files spanning routes, components, and
shared hooks. Overall, it is well-structured with proper hook usage, but has several issues around type safety,
form validation, and some edge cases in the mount/settings management.

## Architecture Compliance

**Passing:**
- No direct `useQuery`/`useMutation` in app code -- all data access goes through hooks in `@workspace/lib/people`,
  `@workspace/lib/team`, `@workspace/lib/settings`, and `@workspace/lib/calendar`.
- Proper `AppShell` + sidebar with `ColumnLayout`/`Column` pattern for members and teams.
- Auth guard in `_auth.tsx` with admin/owner role check (line 53: `currentMember.role === 'member'` rejects).
- Query key hierarchy follows project conventions (`peopleKeys`, `teamKeys`, `settingsKeys`, `teamMountKeys`).
- Mutation `onSuccess` callbacks properly invalidate related query keys.
- `DroppableSidebarItem` enables drag-and-drop member assignment to teams.
- Loading states handled with `EigenLoader` in all routes and the settings page.

**Deviations:**
- `interface` used heavily in component files (8 instances) where `type` is preferred.
- Several `as any` type casts in hooks and components, weakening type safety.

## Issues Found

### Critical

None.

### Important

1. **`as any` type cast in team settings save hides potential type mismatch**
   `apps/people/src/components/people/team-detail.tsx`, line 248:
   ```typescript
   await updateSettings.mutateAsync({
       calendar: {enabled: draftCalEnabled},
       memberOverrides: {
           mailAndContactsMaxMB: draftMailMax ? Number(draftMailMax) : null,
           defaultMountMaxSizeMB: draftMountMax ? Number(draftMountMax) : null,
       },
   } as any);
   ```
   The `as any` cast masks a real type issue: `memberOverrides` fields use `null` to indicate "inherit from
   server default", but the `TeamSettings` type defines them as `number | undefined`, not `number | null`. The
   cast hides this discrepancy. The backend may or may not handle `null` correctly -- this should be explicitly
   typed.

2. **Multiple `as any` casts in shared hooks reduce type safety**
   - `packages/lib/src/core/people/hooks/use-members.ts:35,77`: `role: role as any` -- the role string from the
     form is cast to bypass better-auth's role type. Should use a proper union type.
   - `packages/lib/src/core/team/hooks/use-team-mounts.ts:27,40`: API call bodies cast `as any`.
   - `packages/lib/src/core/settings/hooks/use-server-settings.ts:26`: Settings update body cast `as any`.
   - `packages/lib/src/core/settings/hooks/use-s3-config.ts:26`: S3 config put body cast `as any`.
   These are all in the shared hook layer, meaning every consumer inherits the weak typing.

3. **Server settings form has no input validation**
   `apps/people/src/components/people/server-settings.tsx`.
   Quota values are bound directly to `<Input type="number">` with only `min` attributes. There is no validation
   that prevents:
   - NaN values (clearing the input and saving).
   - Negative values via keyboard input (type="number" min doesn't prevent typing negatives).
   - maxUploadSizeMB exceeding maxBatchUploadSizeMB.
   - Unreasonably small values (e.g., 0 MB mount size).
   The `updateQuota` function at line 56 passes `e.target.valueAsNumber` directly, which returns `NaN` for empty
   inputs.

4. **Team detail quota override inputs accept invalid values**
   `apps/people/src/components/people/team-detail.tsx`, lines 359-366.
   Draft mail/mount max values are stored as strings and converted with `Number()` at save time. No validation
   is performed. `Number('')` returns `0`, but the `draftMailMax ? Number(draftMailMax) : null` check prevents
   that specific case. However, `Number('abc')` returns `NaN` which would be sent to the API.

5. **`location.search.teamId` accessed as raw property without type assertion**
   `apps/people/src/routes/__root.tsx`, line 20:
   ```typescript
   const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;
   ```
   `location.search` is typed by TanStack Router, but at the root level it may not include `teamId`. This relies
   on TypeScript's loose property access on the search object. A runtime check on `typeof` would be safer.

6. **S3 configuration saving and server settings saving are independent operations**
   `apps/people/src/components/people/server-settings.tsx`.
   When switching the default storage type to S3, the user must: (1) change the storage type and save server
   settings, (2) fill in S3 config and save separately. There is no warning if the user saves "storage type = S3"
   without valid S3 credentials configured. This could leave the server in a broken state where new mounts default
   to S3 but no S3 config exists.

### Minor

1. **`interface` used where `type` is preferred (8 instances)**
   In non-generated files:
   - `__root.tsx:9` -- `interface MyRouterContext`
   - `members-list.tsx:14,56` -- `MembersListToolbarProps`, `MembersListProps`
   - `member-detail.tsx:13,49` -- `MemberDetailToolbarProps`, `MemberDetailProps`
   - `people-sidebar.tsx:19` -- `PeopleSidebarProps`
   - `create-user-dialog.tsx:12` -- `CreateUserDialogProps`

2. **Create user dialog does not reset form on cancel if partially filled**
   `apps/people/src/components/people/create-user-dialog.tsx`, line 98.
   The cancel button calls `onOpenChange(false)` but does not reset the `name`, `username`, `password`, `role`
   state. If the user opens the dialog, fills in some fields, cancels, and reopens -- the old values remain.
   The reset only happens on successful creation (lines 34-37).

3. **Team sidebar links use query string navigation instead of TanStack Router search params**
   `apps/people/src/components/people/people-sidebar.tsx`, line 97:
   ```typescript
   to={`/teams?teamId=${team.id}`}
   ```
   This constructs the URL manually with a string template instead of using TanStack Router's `search` parameter
   object, bypassing type safety.

4. **`organizationId` prop is unused in `CreateUserDialog`**
   `apps/people/src/components/people/create-user-dialog.tsx`, line 18:
   The component accepts `organizationId` as a prop but destructures it away and never uses it. The `useCreateUser`
   hook at line 23 doesn't take an organizationId parameter. Dead parameter.

5. **MembersList uses `member.id` for row click but `member.userId` for selection**
   `apps/people/src/components/people/members-list.tsx`.
   - `onRowClick` is called with `member.id` (line 114) -- this is the membership ID.
   - `selection.handleItemClick` uses `member.userId` (line 112) -- this is the user ID.
   - `activeMemberId` is compared against `member.id` (line 108).
   This is internally consistent but could be confusing. The drag system uses `userId` while the URL params and
   detail view use the membership `id`.

6. **TeamDetail component is very large (500+ lines including all sub-components)**
   `apps/people/src/components/people/team-detail.tsx` contains `TeamDetailToolbar`, `AddMemberDialog`,
   `MountDialog`, and `TeamDetail` all in one file. Consider extracting `AddMemberDialog` and `MountDialog`
   into separate files for readability.

7. **No confirmation dialog for removing team members**
   `apps/people/src/components/people/team-detail.tsx`, line 299-305.
   Clicking the X button on a team member immediately triggers `handleRemoveMember` without a confirmation
   dialog, unlike team deletion and member removal which both use `DeleteDialog`.

## Recommendations

1. Add proper input validation to the server settings form. Use zod + react-hook-form (consistent with the
   pattern used in Space app) or at minimum validate before saving. Guard against NaN and 0 values.
2. Address the `as any` casts systematically. For the role field, define a `OrgRole = 'owner' | 'admin' | 'member'`
   type. For API bodies, investigate whether the Eden Treaty types can be made compatible.
3. Add a warning or validation when switching to S3 storage type without valid S3 credentials.
4. Add a confirmation dialog before removing team members, matching the pattern used for team/org member deletion.
5. Reset form state in `CreateUserDialog` when the dialog closes (not just on success).
6. Remove the unused `organizationId` prop from `CreateUserDialog`.
7. Consider splitting `team-detail.tsx` into smaller focused components.
8. Replace `interface` with `type` in non-generated files per project convention.
