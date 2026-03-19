# BE Code Review: People

## Summary

The People backend covers organization and team management. The code is distributed across:

- `apps/api/src/lib/org/org.ts` -- org existence check
- `apps/api/src/lib/team/team.ts` -- team lookup, existence check, member listing
- `apps/api/src/lib/core/access.ts` -- access control helpers (`requireSelf`, `requireTeamAccess`, `requireTeamAdmin`)
- `apps/api/src/routes/team.ts` -- team settings, mounts
- `apps/api/src/routes/settings.ts` -- server settings (admin-only)
- `apps/api/src/routes/home.ts` -- user home size/export

Most org/team CRUD operations are delegated to `better-auth`'s organization plugin (invitations, member management,
role changes) rather than custom routes. The custom routes handle team-specific Eigen features (settings, mounts,
calendars). The access control layer is compact and well-designed.

## Critical Issues

### 1. `requireTeamAccess` grants org admins full team admin access (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/access.ts`, lines 10-16

```typescript
export async function requireTeamAccess(userId: string, teamId: string): Promise<'admin' | 'member'> {
    const role = await getOrgRole(userId);
    if (role === 'admin' || role === 'owner') return 'admin';
...
}
```

Any org-level admin or owner gets `'admin'` access to every team, even teams they are not a member of. While this may
be intentional for org management, it means an org admin can modify the settings (including quota overrides and mounts)
of any team without being a member.

**Impact**: This is likely by design (admins manage everything), but should be documented. The docs say team `owner`
role can "edit team, manage members" but org admins bypass this entirely.

**Risk**: If the org grows, admins who should only manage some teams can access all team settings.

### 2. `getTeamMembers` silently swallows errors (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/team/team.ts`, lines 14-24

```typescript
export async function getTeamMembers(teamId: string) {
    try {
    ...
    } catch {
        return [];
    }
}
```

Any database error (corruption, schema mismatch, connection issue) returns an empty array instead of propagating the
error. This makes debugging extremely difficult and can lead to downstream issues (e.g., ACL checks that rely on
team membership returning false negatives, granting or denying access incorrectly).

**Fix**: Remove the try/catch or log the error. If a graceful fallback is needed, at minimum log a warning.

### 3. Team routes do not use `:ownerId` path segment (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/team.ts`

Per CLAUDE.md: "Every authenticated route must include `:ownerId` as the second path segment." The team routes use
`/team/:teamId/...` instead of `/team/:ownerId/:teamId/...`. While teams are identified by `teamId` rather than
`ownerId`, this deviates from the documented pattern and means the load-balancer sharding strategy described in
CLAUDE.md cannot route team requests by ownerId.

**Mitigation**: Either restructure to `/team/team_:teamId/settings` (using the team's ownerId as the path segment)
or document this as an intentional exception. The current `requireTeamAccess` and `requireTeamAdmin` guards provide
proper authorization regardless.

## Pattern Violations

### 4. `getOrgRole` returns `null` for non-members instead of throwing (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/user/user.ts`, lines 41-44

```typescript
export async function getOrgRole(userId: string): Promise<string | null> {
    const row = await db.select({role: member.role}).from(member).where(eq(member.userId, userId)).get();
    return row?.role ?? null;
}
```

The return type is `string | null`, which means callers must handle `null`. In `requireTeamAccess`, a `null` role
correctly falls through to the team membership check. But in `requireAdmin` (settings router), a `null` role correctly
triggers the 403. The typing is loose though -- `role` should be typed as `'owner' | 'admin' | 'member' | null`
rather than `string | null`.

### 5. Team settings PUT accepts `memberOverrides` with nullable fields (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/team.ts`, lines 26-29

```typescript
memberOverrides: body.memberOverrides ? {
    mailAndContactsMaxMB: body.memberOverrides.mailAndContactsMaxMB ?? undefined,
    defaultMountMaxSizeMB: body.memberOverrides.defaultMountMaxSizeMB ?? undefined,
} : undefined,
```

The body schema allows `t.Nullable(t.Number({minimum: 10}))` for the override fields. The route then converts `null`
to `undefined`. This null-to-undefined conversion is a code smell -- it would be cleaner to use `t.Optional` in the
schema instead of `t.Nullable`, or handle the semantics consistently. The intent is: `null` means "clear the
override", `undefined` means "don't change", and a number means "set the override". This three-state logic works but
is not obvious.

## Security Concerns

### 6. `requireAdmin` check on settings routes is correct (positive finding)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/settings.ts`, lines 9-12

The `requireAdmin` function correctly checks the org role before allowing access to server settings. This is properly
applied to all settings endpoints (GET, PUT for server settings, S3 config, and S3 check).

### 7. Team mount creation has no upper bound on `maxSizeMB` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/team.ts`, lines 53-61

```typescript
body: t.Object({
    name: t.String({minLength: 1}),
    storageType: t.Optional(t.Union([...])),
    maxSizeMB: t.Optional(t.Number({minimum: 10})),
}),
```

There is no maximum on `maxSizeMB`. A team admin (or org admin) could set an arbitrarily large quota. While the
server settings define `defaultMountMaxSizeMB` as a default, there is no enforcement that a team mount cannot exceed
the server-level maximum.

**Fix**: Add a `maximum` constraint or validate against `serverSettings.quotas.defaultMountMaxSizeMB`.

### 8. Mount name and ID not sanitized (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/team.ts`, lines 53-54

The mount `name` is validated to be non-empty (`minLength: 1`), but there is no check for special characters, path
traversal sequences (`..`), or control characters. Since mount names are used in file system operations (via
`TeamHome.addMount`), this could be a path traversal risk depending on how `addMount` uses the name.

**Fix**: Validate mount names against a safe character set (alphanumeric, hyphens, underscores).

### 9. S3 credentials passed in request body (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/settings.ts`, lines 75-84

The `/settings/s3check` endpoint accepts S3 credentials (access key, secret key) in the request body and uses them
to test a connection. This is admin-only and authenticated, which is appropriate. However, the S3 secret access key
could be logged by request logging middleware. Ensure no request body logging is active for this endpoint.

## Data Integrity

### 10. `getTeam` returns only `id` and `name` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/team/team.ts`, lines 5-8

```typescript
return await db.select({id: team.id, name: team.name}).from(team).where(eq(team.id, teamId)).get()
```

The function selects only `id` and `name`. If callers need other fields (e.g., `createdAt`, `organizationId`), they
must be added here. The `getPublicInfo` function in `public.ts` only needs `name`, so this is currently sufficient,
but it's a tight coupling.

### 11. No validation that team belongs to the org (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/team.ts`

The team routes accept any `teamId` and check team membership or org admin status. But there is no explicit check
that the team belongs to the caller's organization. In a single-org deployment this is fine, but if multi-org is
ever introduced, a user in Org A could potentially access a team in Org B (if they somehow knew the team ID and had
admin role in their own org).

**Mitigation**: Low risk in single-org mode. Add org scoping if multi-org is introduced.

## Code Quality

### 12. Org module is minimal (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/org/org.ts`

The entire org module is a single function (`getOrgExists`). Most org operations are delegated to better-auth's
organization plugin. This is clean and avoids duplication, but the module could be removed and the function inlined
where used, reducing indirection.

### 13. Team module mixes concerns (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/team/team.ts`

The team module has three functions: `getTeam`, `getTeamExists`, `getTeamMembers`. These are pure database queries
with no business logic. Consider whether they should live in the team module or be inlined in the access control layer,
which is their primary consumer.

## Architecture

- The delegation to better-auth for org/team CRUD is a good architectural choice -- it avoids reimplementing
  invitation, role management, and membership logic.
- The `requireTeamAccess` / `requireTeamAdmin` access control pattern is clean and composable.
- Team settings and mounts are managed through `TeamHome`, following the Home singleton pattern.
- The settings router correctly separates server-level settings from team-level settings.

## Positive Patterns

- `requireTeamAccess` returns a role enum, allowing callers to make fine-grained decisions.
- `requireTeamAdmin` composes on top of `requireTeamAccess` rather than duplicating logic.
- All team routes are properly guarded with auth and authorization checks.
- Server settings routes use a dedicated `requireAdmin` check.
- Body validation schemas use `t.Object` with proper constraints (minimum values, string lengths).
- The mount CRUD operations follow a clean REST pattern.

## Recommendations

| Priority | Issue                                        | Action                                          |
|----------|----------------------------------------------|-------------------------------------------------|
| P1       | #1 Org admins get full team access           | Document or restrict                            |
| P1       | #2 Silent error swallowing in getTeamMembers | Remove try/catch or log                         |
| P1       | #3 Team routes missing `:ownerId`            | Restructure or document exception               |
| P2       | #4 Loose return type on getOrgRole           | Use union type                                  |
| P2       | #5 Nullable vs Optional confusion            | Simplify to Optional                            |
| P2       | #7 No maxSizeMB upper bound                  | Add maximum or validate against server settings |
| P2       | #8 Mount name not sanitized                  | Validate against safe character set             |
| P2       | #9 S3 credentials in body                    | Ensure no request body logging                  |
| P2       | #11 No org scoping on team routes            | Add if multi-org is introduced                  |
