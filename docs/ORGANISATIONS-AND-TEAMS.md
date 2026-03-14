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
