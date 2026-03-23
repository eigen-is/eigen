# Organizations & Teams

> **TLDR**: Single-org, self-hosted. One org created at setup. All users auto-joined. Teams are flat groups for ACL
> sharing and shared drives. Team drives use `TeamHome` with synthetic user `team_{teamId}`. Prefixed owner IDs: raw
> UUID = user, `team_` prefix = team.

## Organization

Created during setup wizard. Uses better-auth `organization()` plugin with `teams: { enabled: true }`.

- All new users auto-joined as `member`
- Setup admin becomes `owner`
- Config stored in `serverConfig` (`data/server/`)

| Role     | Description                                     |
|----------|-------------------------------------------------|
| `owner`  | Full org management (setup admin)               |
| `admin`  | Manage members and teams                        |
| `member` | Default. Uses shared drives they have access to |

## Teams

Flat groups within the org serving two purposes:

1. **ACL groups**: Share with `team_{id}` instead of individual emails
2. **Shared drives**: Team-owned storage (`TeamHome`)

| Team Role | Description                 |
|-----------|-----------------------------|
| `owner`   | Edit team, manage members   |
| `member`  | Default. ACL + drive access |

### TeamHome

**File**: `apps/api/src/lib/home/team-home.ts`

- Synthetic user ID: `team_{teamId}`
- Path: `data/team/{teamId}/`
- Services: Drive + Calendar only (no mail/contacts)
- Created lazily, auto-destructs after 5min inactivity

## Prefixed Owner IDs

All drives use `/drive/:ownerId/:mountId/...`. The `ownerId` encodes type:

| Type | Format          | Example         |
|------|-----------------|-----------------|
| User | Raw UUID        | `a1b2c3d4-...`  |
| Team | `team_{teamId}` | `team_x9y8z7w6` |

**Resolution** (`packages/lib/src/types/owner.ts`):

```typescript
parseOwnerId("a1b2c3d4")      → { type: 'user', id: 'a1b2c3d4' }
parseOwnerId("team_x9y8z7w6") → { type: 'team', id: 'x9y8z7w6' }
```

**Drive resolution** (`apps/api/src/lib/drive/get-drive.ts`): `getSharedDrive(ownerId, user)` dispatches to `UserHome`
or `TeamHome`.

## Team ACL

```typescript
// Share folder with team
{ id: 'team_xyz', read: true, write: false }
```

Resolution: `canRead`/`canWrite` → `parseOwnerId` → `getMemberships(userId)` → check team membership.

`filterRedundantACL()` strips team ACL entries covered by inherited permissions or ownership.

## Frontend

- **Sidebar**: Team drives appear under "Shared Drives" in Drive app
- **Share dialog**: `drive-access-list-edit.tsx` supports team picker + team display
- **Auth hooks** (`packages/lib/src/core/auth/hooks/`): `useOrganization()`, `useTeams(orgId?)`, `useMembers(orgId?)`

## Files

| File                                   | Purpose                                    |
|----------------------------------------|--------------------------------------------|
| `packages/lib/src/types/owner.ts`      | `parseOwnerId`, `teamOwnerId`, `OwnerType` |
| `apps/api/src/lib/home/team-home.ts`   | TeamHome class + factory                   |
| `apps/api/src/lib/drive/get-drive.ts`  | Dispatch by owner type                     |
| `apps/api/src/lib/drive/acl.ts`        | ACL with team support                      |
| `apps/api/src/lib/drive/membership.ts` | `getMemberships()`                         |

## People App

Admin UI for org member + team management at `apps/people/`. Requires org role `admin` or `owner`. Uses better-auth
client API for all operations.

### Pages

- **Members**: List, invite, change role, remove org members, fully delete user accounts
- **Teams**: List, create, rename, delete teams
- **Team Detail**: List/add/remove team members, toggle team calendar on/off, set calendar member access
  (free-busy/read/write)

### Access

Route guard checks: authenticated + org role `admin` or `owner`. Visible via "People" in app switcher.

### API

Org/team management via `authClient.organization.*` (better-auth client). Team calendar settings via
`GET/PUT /calendar/team/:teamId/settings` (stored in `data/team/{teamId}/settings.json`).

### User Deletion

`DELETE /settings/user/:userId` — admin-only, permanently deletes a user and all their data:

1. Evicts cached Home singleton (closes databases)
2. Deletes home directory (`data/home/{userId}/`)
3. Cleans share registry (entries FROM and TO the user)
4. Removes org/team memberships
5. Deletes auth records via better-auth (sessions, accounts, 2FA)

**Frontend**: `useDeleteUser(organizationId)` hook. "Danger zone" section in member detail with confirmation dialog.
