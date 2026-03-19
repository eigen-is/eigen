# FE Code Review: People

## Summary

The People frontend is an admin UI for organization member and team management. The code lives in:

- `apps/people/src/` -- routes and components
- `packages/lib/src/core/people/` -- hooks, query keys
- `packages/lib/src/core/team/` -- team settings/mount hooks, SSE handlers
- `packages/lib/src/types/people.ts` -- shared types

The app is feature-rich with member management, team detail views with mount/calendar/quota management, a server
settings page, and drag-to-add-member functionality. The code quality is generally good, but there are several issues
around access control, missing `await`, pattern violations, and error handling.

## Critical Issues

### 1. Missing `await` on `authClient.organization.setActive` (P0)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/routes/_auth.tsx`, line 31

```typescript
authClient.organization.setActive({organizationId: config.orgId});
```

Per CLAUDE.md: "Always `await` async calls -- missing `await` is the #1 bug class in this codebase. A bare async call
returns a truthy Promise, silently skipping the intended logic."

This async call is not awaited. If `setActive` fails (network error, invalid org), the error is silently ignored and
the component continues rendering as if the org were activated. This could lead to subsequent API calls failing in
confusing ways.

**Fix**: `await authClient.organization.setActive({organizationId: config.orgId});` and add error handling.

### 2. Admin check is client-side only, not enforced in auth guard's `beforeLoad` (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/routes/_auth.tsx`, lines 22-64

The auth guard checks authentication in `beforeLoad` (line 10), but the admin/owner role check happens in the
component body (lines 51-53):

```typescript
const currentMember = members.find(m => m.userId === user?.id);
if (!currentMember || currentMember.role === 'member') {
    return <div>Access Denied</div>;
}
```

This means:

1. The full member list is fetched before checking access (data leak).
2. A non-admin user briefly sees the People app shell before seeing "Access Denied".
3. The check relies on the client-side member list, which could be manipulated.

The real security is provided by the backend (better-auth enforces org roles on its API, and custom routes use
`requireAdmin`/`requireTeamAdmin`). But the UX is suboptimal.

**Fix**: Move the role check to `beforeLoad` or a route loader, or redirect non-admins immediately.

## Pattern Violations

### 3. `interface` used instead of `type` throughout People components (P2)

Per CLAUDE.md: "Always `type` over `interface` -- except when methods are needed."

The following files use `interface` for props types (which have no methods):

- `/Users/reinder/Documents/GitHub/eigen/apps/people/src/routes/__root.tsx`, line 9: `interface MyRouterContext`
- `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/members-list.tsx`, lines 14, 56
- `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/people-sidebar.tsx`, line 19
- `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/member-detail.tsx`, lines 13, 49
- `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/create-user-dialog.tsx`, line 12

**Fix**: Replace `interface` with `type` for all props types.

### 4. Hardcoded color in server settings (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/server-settings.tsx`, line 274

```typescript
className={`... ${s3CheckResult.ok ? 'text-green-600' : 'text-destructive'}`}
```

Per CLAUDE.md: "Use theme tokens, not hardcoded colors." The success color `text-green-600` is a hardcoded Tailwind
color that will not adapt to dark mode. The failure color `text-destructive` correctly uses a theme token.

**Fix**: Use `text-chart-2` or another semantic token for success, matching the pattern in `change-password.tsx`.

### 5. Query keys do not include `orgId` (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/people/hooks/keys.ts`

```typescript
export const peopleKeys = {
    all: ['people'] as const,
    members: () => [...peopleKeys.all, 'members'] as const,
    teams: () => [...peopleKeys.all, 'teams'] as const,
    ...
};
```

Per CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data." The members and teams lists are
org-scoped but the query keys do not include `orgId`. While Eigen is single-org, this violates the documented pattern
and could cause stale data if multi-org is ever introduced.

**Fix**: Include `orgId` in the query keys: `members: (orgId: string) => [...peopleKeys.all, 'members', orgId]`.

## Security Concerns

### 6. `useCreateUser` calls `authClient.admin.createUser` (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/people/hooks/use-members.ts`, lines 64-86

The `useCreateUser` hook calls `authClient.admin.createUser`, which is a better-auth admin endpoint. The access
control relies on better-auth's admin plugin to restrict this to admin users. This should be verified -- if the
admin plugin is not properly configured, any authenticated user could create users.

### 7. Role change allows setting `owner` in the UI (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/member-detail.tsx`, lines 57, 82

```typescript
const handleRoleChange = async (newRole: 'admin' | 'member' | 'owner') => { ... }
```

The function signature accepts `'owner'` as a valid role, and the `Select` component's `onValueChange` casts via
`v as 'admin' | 'member' | 'owner'`. While the UI only shows `admin` and `member` options in the `SelectContent`
(lines 88-89), the type allows `owner`, meaning a programmatic call or DOM manipulation could attempt to set the
owner role. The backend (better-auth) should reject this, but the frontend type is too permissive.

**Fix**: Restrict the type to `'admin' | 'member'` and remove `'owner'` from the cast.

### 8. Create user dialog does not validate password strength (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/create-user-dialog.tsx`, lines 75-76

```html
<Input id="password" type="password" ... minLength={8} required/>
```

The only validation is `minLength={8}`, which is an HTML attribute. There is no `zod` schema validation (unlike the
Space password change form which uses `validatePasswordStrength`). A weak 8-character password like "12345678" would
be accepted.

**Fix**: Add zod validation with password strength checking, consistent with the Space app.

## Data Integrity

### 9. Team calendar share logic has edge case (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/team-detail.tsx`, lines 249-255

```typescript
const shares = draftCalPermission === 'read'
    ? (existingShares.length > 0 ? existingShares : null)
    : [...existingShares, {targetId: teamTarget, permission: draftCalPermission}];
```

When permission is `'read'`, the code removes the team share entry (since `read` is the default). But if
`existingShares` has other entries, it keeps them. If `existingShares` is empty, it sets shares to `null`. This logic
is correct but fragile -- the intent (remove team-specific share for default read) should be clearer.

### 10. Draft state not synced when team changes (partial fix) (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/team-detail.tsx`, lines 224-226

```typescript
useEffect(() => {
    setShowSettingsForm(false);
}, [team.id]);
```

When the selected team changes, the settings form is hidden. But the draft state variables (`draftName`,
`draftCalEnabled`, etc.) are not reset. If the user opens the settings form for Team A, makes changes, switches to
Team B, and opens the settings form, the stale draft from Team A may briefly appear before `openSettingsForm`
overwrites it.

**Fix**: Reset all draft state in the `useEffect`, or initialize drafts lazily in `openSettingsForm` only (which is
already done -- `openSettingsForm` sets all draft values, so the risk is minimal).

### 11. `createdAt` assumed to be Date in member list (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/member-detail.tsx`, line 96

```typescript
<p className="text-sm">{member.createdAt.toLocaleDateString()}</p>
```

The `OrgMember` type defines `createdAt: Date`, and the hook constructs it via `new Date(m.createdAt)`. If the
backend returns a malformed date string, `new Date(...)` produces an `Invalid Date` object, and
`toLocaleDateString()` returns `"Invalid Date"`. No validation is performed.

## Code Quality

### 12. Large component: `TeamDetail` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/team-detail.tsx`

At ~510 lines, `TeamDetail` handles team settings editing, mount management, member management, and calendar
configuration. Consider extracting into sub-components:

- `TeamSettingsForm` (settings editing)
- `TeamMountList` (mount CRUD)
- `TeamMemberList` (member management)

This would improve readability and testability.

### 13. Sidebar team navigation uses string interpolation for URLs (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/people-sidebar.tsx`, line 97

```typescript
to={`/teams?teamId=${team.id}`}
```

Using string interpolation for URLs with query params bypasses TanStack Router's type-safe navigation. The `to` prop
should use the `search` parameter: `to="/teams" search={{teamId: team.id}}`.

**Fix**: Use typed navigation: `to="/teams"` with `search={{teamId: team.id}}`.

### 14. Missing `await` on `navigate` calls (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/member-detail.tsx`, line 27
**File**: `/Users/reinder/Documents/GitHub/eigen/apps/people/src/components/people/team-detail.tsx`, line 51

```typescript
navigate({to: '/members', search: {}});
navigate({to: '/teams', search: {}});
```

These `navigate` calls inside async handlers are not awaited. While TanStack Router's `navigate` returns a Promise,
not awaiting it in a try/catch block means navigation errors would be unhandled. In practice this rarely fails, but
it violates the `await` rule.

### 15. `organizationId` prop threaded deeply without context (P2)

The `organizationId` prop is passed from `__root.tsx` through `_auth.tsx` (where it's fetched via `usePublicConfig`)
down to every component (`MembersRoute` -> `MemberDetail` -> `MemberDetailToolbar`). Consider using a React context
or a shared hook to avoid prop drilling.

## Architecture

- The People app correctly delegates org/team CRUD to better-auth's client API (`authClient.organization.*`) and
  custom team features (settings, mounts) to the Eigen API.
- The hooks layer in `packages/lib/src/core/people/` is well-structured with proper query key patterns.
- Team SSE handlers correctly invalidate all team settings when a team settings update event is received.
- The sidebar's drag-and-drop for adding members to teams is a nice UX feature.
- The server settings page is comprehensive with S3 configuration and connection testing.

## Positive Patterns

- All mutations use `try/catch` with `toast.error()` -- every mutation has error feedback.
- Hooks live in `packages/lib/src/core/people/hooks/` as required.
- `invalidateQueries` used correctly in `onSuccess` callbacks.
- No `useQuery`/`useMutation` used directly in app components.
- No `as any` in non-generated code.
- No `"use client"` directives.
- `ColumnLayout` and `Column` used correctly for responsive layouts.
- `DroppableSidebarItem` enables intuitive drag-to-add UX.
- Proper use of `DeleteDialog` for destructive actions.
- `EigenLoader` used consistently for loading states.

## Recommendations

| Priority | Issue                              | Action                                 |
|----------|------------------------------------|----------------------------------------|
| P0       | #1 Missing `await` on `setActive`  | Add `await` and error handling         |
| P1       | #2 Client-side admin check         | Move to beforeLoad or loader           |
| P1       | #5 Query keys missing orgId        | Add orgId to people query keys         |
| P1       | #6 Admin user creation access      | Verify better-auth admin plugin config |
| P2       | #3 `interface` instead of `type`   | Replace throughout                     |
| P2       | #4 Hardcoded color                 | Use theme token                        |
| P2       | #7 Role change type too permissive | Restrict to `'admin' \| 'member'`      |
| P2       | #8 No password strength validation | Add zod + validatePasswordStrength     |
| P2       | #12 Large TeamDetail component     | Extract sub-components                 |
| P2       | #13 String URL interpolation       | Use typed navigation                   |
| P2       | #14 Missing `await` on navigate    | Add `await`                            |
| P2       | #15 Prop drilling organizationId   | Use context or shared hook             |
