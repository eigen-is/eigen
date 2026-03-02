# Organizations & Teams

Eigen is a **single-org, self-hosted** system. One organization is created during setup. All users are auto-joined as members. Teams are the primary mechanism for group-based sharing and shared drives.

## Organization

The organization is created during the setup wizard (name configurable, default "Eigen"). It uses better-auth's `organization()` plugin with `teams: { enabled: true }`.

- All new users are auto-joined to the default org as `member`.
- The setup admin becomes org `owner`.
- Org data (orgId, orgName) is stored in `serverConfig` (config.db).

### Organization Roles (`member.role`)

| Role | Description |
|------|-------------|
| `owner` | Full org management. Assigned to setup admin. |
| `admin` | Can manage members and teams. |
| `member` | Default. Can use shared drives they have access to. |

## Teams

Teams are flat groups within the organization. They serve two purposes:

1. **ACL groups**: Share files/folders with a team instead of individual emails.
2. **Shared drives**: Team-owned storage not tied to an individual user.

### Team Roles (`teamMember.role`)

| Role     | Description                                         |
|----------|-----------------------------------------------------|
| `owner`  | Can edit team, add/remove members.                  |
| `member` | Default. Part of the team for ACL and drive access. |

### Team Drives (TeamHome)

Each team gets its own `TeamHome` instance (`apps/api/src/lib/home/team-home.ts`), extending `Home` with a synthetic
user ID `team_{teamId}`. TeamHome only initializes a Drive (no mail or contacts).

- Data stored at `{EIGEN_DATA_ROOT}/team/{teamId}/`
- All team members automatically have read+write access to the team drive.
- Non-members cannot access team drive content unless given explicit ACL.

```
{EIGEN_DATA_ROOT}/team/{teamId}/
└── mounts/
    └── default/
        ├── metadata.db
        ├── data/
        ├── thumbs/
        └── tmp/
```

### Team Drive Lifecycle

- Created lazily on first access via `getTeamHome(teamId)`.
- Auto-destructs after 5 minutes of inactivity (like user Home).
- Factory cache in `teamHomeFactories` Map.

## Prefixed Owner IDs

All drives use the same URL pattern `/drive/:ownerId/:mountId/...`. The `ownerId` encodes ownership type via prefix:

| Type | Format | Example |
|------|--------|---------|
| User | Raw UUID (no prefix) | `a1b2c3d4-...` |
| Team | `team_{teamId}` | `team_x9y8z7w6` |

### Resolution (`packages/lib/src/types/owner.ts`)

```typescript
type OwnerType = 'user' | 'team';

parseOwnerId("a1b2c3d4")      → { type: 'user', id: 'a1b2c3d4' }
parseOwnerId("team_x9y8z7w6") → { type: 'team', id: 'x9y8z7w6' }
```

### Drive Resolution (`apps/api/src/lib/drive/get-drive.ts`)

`getSharedDrive(ownerId, user)` parses the owner ID and dispatches:
- `user` → `getHome(owner)` → `home.drive` (wrapped in `SharedDrive` if not the requesting user)
- `team` → `getTeamHome(teamId)` → `teamHome.drive`

## Team ACL

Teams can be used as ACL targets on any drive path (personal or team-owned):

```typescript
export type DriveACL = {
    id: string;        // team_ID
    read: boolean;
    write: boolean;
}
```

### How Team ACL Works

1. Alice shares folder with Team "Engineering": `{id: 'team_xyz', read: true, write: false}`
2. Bob (Engineering member) accesses folder → `canRead` checks ACL → finds team entry → `parseOwnerId` determines it's a
   team → calls `getMemberships(bob.id)` → confirms Bob is in team → grants access.
3. Charlie (not in Engineering) is denied.

### ACL + Team Membership Resolution

`canRead`/`canWrite` in `acl.ts` accept an optional `getMemberships` function:

- For team-owned paths: membership grants automatic read+write (checked before ACL).
- For ACL entries with `type: 'team'`: resolves user's team memberships via `getMemberships(userId)` querying
  better-auth tables.

### Redundant ACL Filtering

`filterRedundantACL()` in `acl.ts` strips ACL entries covered by:

- **Inherited permissions**: from parent paths (walks up parent chain).
- **Ownership**: team ACL on a path owned by the same team is redundant.

## Frontend Integration

### Sidebar (Drive App)

Team drives appear in "Shared Drives" below "Shared with me". Each team drive uses a `SharedDriveItem` component
resolving the team's root pathId via `useRootFolder(ownerId)`.

### Share Dialog

The share dialog (`drive-access-list-edit.tsx`) supports teams:

- **Team picker**: dropdown at bottom-left (`useTeams()`).
- **Team owner display**: team-owned paths show the team as owner with a Users icon.
- **Inherited team ACL**: shows team name with group icon and source folder.
- **Team name resolution**: handled natively by `UserPublicItem`.

### Auth Hooks (`packages/lib/src/lib/auth/hooks/`)

| Hook | Purpose |
|------|---------|
| `useOrganization()` | Returns the user's org (via `organization.list()`) |
| `useTeams(orgId?)` | Lists teams in the org |
| `useMembers(orgId?)` | Lists org members |

## Membership Resolution (`apps/api/src/lib/drive/membership.ts`)

```typescript
type Memberships = {
    orgIds: string[];   // Organizations the user belongs to
    teamIds: string[];  // Teams the user belongs to
}
```

`getMemberships(userId)` queries better-auth's `member` and `teamMember` tables. Used by ACL checks to resolve team-based access.

## Files

| File | Purpose |
|------|---------|
| `packages/lib/src/types/owner.ts` | `parseOwnerId`, `teamOwnerId`, `userOwnerId`, `OwnerType` |
| `packages/lib/src/types/drive.ts` | `DriveACL` with `type`/`targetId` fields |
| `apps/api/src/lib/home/team-home.ts` | `TeamHome` class + `getTeamHome()` factory |
| `apps/api/src/lib/drive/get-drive.ts` | `getSharedDrive()` — dispatches by owner type |
| `apps/api/src/lib/drive/acl.ts` | `canRead`, `canWrite`, `filterRedundantACL` with team support |
| `apps/api/src/lib/drive/membership.ts` | `getMemberships()` — resolves user's org+team memberships |
| `apps/api/src/lib/drive/drive.ts` | `updateACL()` with redundant ACL filtering |
| `apps/api/src/routes/drive.ts` | ACL route accepting `type: 'team'` |
| `apps/drive/src/components/drive/drive-sidebar.tsx` | Team drives in sidebar |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Share dialog with team support |
| `packages/lib/src/lib/auth/hooks/use-organization.ts` | `useOrganization`, `useTeams`, `useMembers` |
| `apps/api/src/test/org-drive.test.ts` | Team drive + team ACL + redundant ACL tests |
