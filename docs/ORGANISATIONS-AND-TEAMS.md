# Organizations & Teams

> **TLDR**: Single-org, self-hosted. One org created at setup. All users auto-joined. Teams are flat groups for ACL
> sharing and shared drives. Three Home subclasses: `UserHome` (personal), `TeamHome` (team drives), `OrgHome`
> (org-level). Prefixed owner IDs: raw UUID = user, `team_` = team, `org_` = org.

## Organization

Created during setup wizard. Uses better-auth `organization()` plugin with `teams: { enabled: true }` and `apiKey()`
plugin.

- All new users auto-joined as `member` (via `databaseHooks.user.create.after`)
- Setup admin becomes `owner`
- Config stored in `serverConfig` (`data/server/`)
- New users also trigger share reconciliation (`reconcileSharesForNewUser`)

| Role     | Description                                     |
|----------|-------------------------------------------------|
| `owner`  | Full org management (setup admin)               |
| `admin`  | Manage members, teams, and server settings      |
| `member` | Default. Uses shared drives they have access to |

## Teams

Flat groups within the org serving two purposes:

1. **ACL groups**: Share with `team_{id}` instead of individual emails
2. **Shared drives**: Team-owned storage (`TeamHome`)

| Team Role | Description                 |
|-----------|-----------------------------|
| `owner`   | Edit team, manage members   |
| `member`  | Default. ACL + drive access |

When a member is added to a team, `reconcileSharesForNewTeamMember` runs to propagate existing team-targeted shares
to the new member's Home.

### TeamHome

**File**: `apps/api/src/lib/home/team-home.ts`

- Synthetic user ID: `team_{teamId}`
- Path: `data/team/{teamId}/`
- Services: Drive + Calendar only (no mail/contacts/notifications)
- Starts with zero mounts — mounts are added explicitly via "Add Mount" in People app
- Settings stored in `settings.json` (`JsonStore<TeamSettings>`)
- Calendar can be disabled via `settings.calendar.enabled`
- Created lazily, auto-destructs after 5min inactivity

### OrgHome

**File**: `apps/api/src/lib/home/org-home.ts`

- Synthetic user ID: `org_{orgId}`
- Path: `data/org/{orgId}/`
- No domain services (no drive/mail/contacts/calendar) — just filesystem
- Created lazily via `getHome()` like other Home types

## Home Resolution

**File**: `apps/api/src/lib/home/get-home.ts`

`getHome(ownerId)` parses the owner ID prefix and creates the correct Home subclass:

- Raw UUID → `UserHome` (looks up user in auth DB)
- `team_` prefix → `TeamHome` (verifies team exists)
- `org_` prefix → `OrgHome` (verifies org exists)

All Home instances are cached in a factory map and auto-destruct after 5min idle. `evictHome(ownerId)` forces
immediate shutdown (used during user deletion).

## Prefixed Owner IDs

All drives use `/drive/:ownerId/:mountId/...`. The `ownerId` encodes type:

| Type | Format          | Example         |
|------|-----------------|-----------------|
| User | Raw UUID        | `a1b2c3d4-...`  |
| Team | `team_{teamId}` | `team_x9y8z7w6` |
| Org  | `org_{orgId}`   | `org_a1b2c3d4`  |

**Resolution** (`packages/lib/src/types/owner.ts`):

```typescript
type OwnerType = 'user' | 'team' | 'org';

parseOwnerId("a1b2c3d4")      → { type: 'user', id: 'a1b2c3d4' }
parseOwnerId("team_x9y8z7w6") → { type: 'team', id: 'x9y8z7w6' }
parseOwnerId("org_a1b2c3d4")  → { type: 'org',  id: 'a1b2c3d4' }
```

Helper functions: `userOwnerId(id)`, `teamOwnerId(id)`, `orgOwnerId(id)`.

**Drive resolution** (`apps/api/src/lib/drive/get-drive.ts`): `getSharedDrive(ownerId, user)` calls
`getHome(ownerId)` (dispatches to the correct Home subclass) and wraps it in a `SharedDrive`.

## Team Access Control

**File**: `apps/api/src/lib/core/access.ts`

Team routes use `requireTeamAccess` and `requireTeamAdmin`:

- Org `admin`/`owner` roles bypass team membership checks (always get `admin` access)
- Regular users must be a member of the specific team
- `requireTeamAdmin` rejects non-admin team members

## Team ACL

```typescript
// Share folder with team
{ id: 'team_xyz', read: true, write: false }
```

Resolution: `canRead`/`canWrite` → `parseOwnerId` → `getMemberships(userId)` → check team membership.

`getMemberships(userId)` lives in `apps/api/src/lib/user/user.ts` and returns `{ orgIds: string[], teamIds: string[] }`.

`filterRedundantACL()` strips team ACL entries covered by inherited permissions or ownership (e.g., team ACL on a
path owned by the same team).

## Frontend

- **Sidebar**: Team drives appear under "Shared Drives" in Drive app
- **Share dialog**: `drive-access-list-edit.tsx` supports team picker + team display
- **People hooks** (`packages/lib/src/core/people/hooks/`): `usePeopleMembers(orgId?)`, `usePeopleTeams(orgId?)`,
  `useTeamMembers(orgId?, teamId?)`, `useActiveMember()`

## Files

| File                                          | Purpose                                                   |
|-----------------------------------------------|-----------------------------------------------------------|
| `packages/lib/src/types/owner.ts`             | `parseOwnerId`, `teamOwnerId`, `orgOwnerId`, `OwnerType` |
| `apps/api/src/lib/home/get-home.ts`           | Home factory, dispatches by owner type                    |
| `apps/api/src/lib/home/team-home.ts`          | TeamHome class (Drive + Calendar)                         |
| `apps/api/src/lib/home/org-home.ts`           | OrgHome class (filesystem only)                           |
| `apps/api/src/lib/drive/get-drive.ts`         | `getSharedDrive()` — wraps Home in SharedDrive            |
| `apps/api/src/lib/drive/acl.ts`               | ACL with team support                                     |
| `apps/api/src/lib/user/user.ts`               | `getMemberships()`, `getOrgRole()`                        |
| `apps/api/src/lib/core/access.ts`             | `requireTeamAccess`, `requireTeamAdmin`                   |
| `apps/api/src/lib/share/reconciliation.ts`    | Share reconciliation on user/team-member creation         |
| `packages/lib/src/core/people/hooks/keys.ts`  | Query key definitions for people hooks                    |

## People App

Admin UI for org member + team management at `apps/people/`. Requires org role `admin` or `owner`. Uses better-auth
client API (`authClient.organization.*`) for org/team operations and Eden Treaty for server settings.

### Pages

- **Members**: List, create, search, change role, reset password, remove org members, fully delete user accounts.
  Supports drag-and-drop of members onto team sidebar items
- **Teams**: Team list in sidebar with create dialog. Team detail as main content
- **Team Detail**: List/add/remove team members, toggle team calendar on/off, set calendar member access
  (free-busy/read/write), manage mounts (add/edit/enable/disable), set quota overrides (mail & contacts, default mount)
- **Settings**: Server-wide settings — quotas, storage defaults (mount type), S3 configuration

### Access

Route guard in `_auth.tsx`: fetches org members, checks current user has role `admin` or `owner`. Non-admins see
`AccessDenied`. Visible via "People" in app switcher.

### API

Org/team management via `authClient.organization.*` (better-auth client). Team settings and mounts via dedicated
routes:

| Route                           | Method     | Purpose                      |
|---------------------------------|------------|------------------------------|
| `/team/:teamId/settings`       | GET / PUT  | Team settings (calendar, quota overrides) |
| `/team/:teamId/mounts`         | GET        | List team mounts             |
| `/team/:teamId/mount`          | POST       | Add mount to team            |
| `/team/:teamId/mount/:mountId` | PUT        | Update mount settings        |
| `/settings/user/:userId`       | DELETE     | Delete user completely       |
| `/settings/server`             | GET / PUT  | Server-wide settings         |
| `/settings/s3config`           | GET / PUT  | S3 storage configuration     |
| `/settings/s3check`            | POST       | Test S3 connection           |

Team settings are stored in `data/team/{teamId}/settings.json` via `TeamHome.settings` (`JsonStore<TeamSettings>`).

### User Deletion

`DELETE /settings/user/:userId` — admin-only, permanently deletes a user and all their data:

1. Evicts cached Home singleton (closes databases)
2. Deletes home directory (`data/home/{userId}/`)
3. Cleans share registry (entries FROM and TO the user)
4. Removes org/team memberships (explicit deletion since SQLite CASCADE is off by default)
5. Deletes auth records via better-auth `auth.api.removeUser()` (sessions, accounts, 2FA)

Cannot delete own account (server-side guard).

**Frontend**: `useDeleteUser(organizationId)` hook in `packages/lib/src/core/people/hooks/use-members.ts`.
"Danger zone" section in member detail with confirmation dialog.
