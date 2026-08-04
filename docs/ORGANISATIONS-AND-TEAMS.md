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
- Starts with zero mounts — mounts are added explicitly via "Add Mount" in Admin app
- Settings stored in `settings.json` (`JsonStore<TeamSettings>`)
- Calendar can be disabled via `settings.calendar.enabled`
- Created lazily, auto-destructs after 30 min inactivity (`TEAM_HOME_IDLE_MS`, longer than the 5 min a `UserHome`
  gets — a team drive is opened by many people at irregular intervals)

### Team Avatars

Org admins set a team avatar from the admin team detail page (`POST`/`DELETE /team/:ownerId/avatar`, gated by
`requireTeamAdmin`). Storage mirrors the user-avatar pipeline: one webp at `data/server/avatars/team_{teamId}.webp`,
written via `pushTeamAvatar` in `home-relay.ts`. File existence is the only source of truth — no settings pointer,
no schema column. Serving goes through `GET /p/avatar/team_{teamId}`, falling back to the deterministic team SVG,
with the same 24h public `Cache-Control` as user avatars.

**Gotcha**: the team filename is stable (unlike per-upload-UUID user avatars), so the editing surface would show
the browser-cached copy. The admin team detail page appends a client-generated `?v={timestamp}` on mount, on team
switch, and after upload/remove. A `?v` value must never be reused across page loads — a repeated value serves the
stale cache entry, so never use a counter. Other surfaces accept up-to-24h staleness.

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

All Home instances are cached in a factory map and auto-destruct when idle — 5 min by default, 30 min for
`TeamHome`. `evictHome(ownerId)` forces immediate shutdown (used during user deletion).

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
- **Admin hooks** (`packages/lib/src/core/admin/hooks/`, exported from `@workspace/lib/admin`):
  `useMembers(orgId?)`, `useTeams(orgId?)`, `useActiveMember()`, `useAdminUsers(filter)`
- **Team hooks** (`packages/lib/src/core/team/hooks/`, exported from `@workspace/lib/team`):
  `useTeamMembers(teamId)` — takes the raw team id and wraps it with `teamOwnerId()` itself — plus the team
  settings/mounts hooks that share `teamKeys`

## Admin App

Admin UI for org member + team management at `apps/admin/`. Requires org role `admin` or `owner`. Uses better-auth
client API (`authClient.organization.*`) for org/team operations and Eden Treaty for server settings.

### Pages

- **Members**: List, create, search, change role, reset password, remove org members, fully delete user accounts.
  Supports drag-and-drop of members onto team sidebar items
- **Teams**: Team list in sidebar with create dialog. Team detail as main content
- **Team Detail**: List/add/remove team members, toggle team calendar on/off, set calendar member access
  (free-busy/read/write), manage mounts (add/edit/enable/disable), set quota overrides (mail & contacts, default
  mount), set/remove the team avatar (see [Team Avatars](#team-avatars))
- **Settings**: Server-wide settings — quotas, storage defaults (incl. S3), email-notification toggles, landing
  page links. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md)
- **Guests**: guest accounts, with detail + delete — see [GUEST-ACCESS.md](GUEST-ACCESS.md) (the `/guest-settings`
  page next to it holds the guest toggles)
- **Orphans**: users with no org membership, from the same `GET /settings/users/:filter` route
- **Waitlist**: waitlist entries — accept, reject, resend invite, delete
- **Onboarding**: the waitlist toggle and the invite / welcome mail templates

### Access

Route guard in `_auth.tsx`: fetches org members, checks current user has role `admin` or `owner`. Non-admins see
`AccessDenied`. Visible via "Admin" in app switcher.

### API

Org/team management via `authClient.organization.*` (better-auth client). Team settings, mounts and avatar go
through dedicated routes.

Every team route takes `:ownerId` — the prefixed `team_{teamId}` form, not the bare team id. Pass a bare id and
`parseOwnerId` reads it as a *user* id, so the route 404s on a missing user (or 400s on a malformed id). Always
build the segment with `teamOwnerId(teamId)`.

| Route                            | Method     | Purpose                                   |
|----------------------------------|------------|-------------------------------------------|
| `/team/:ownerId/members`         | GET        | List team members                         |
| `/team/:ownerId/settings`        | GET / PUT  | Team settings (calendar, quota overrides) |
| `/team/:ownerId/mounts`          | GET        | List team mounts                          |
| `/team/:ownerId/mount`           | POST       | Add mount to team                         |
| `/team/:ownerId/mount/:mountId`  | PUT        | Update mount settings                     |
| `/team/:ownerId/avatar`          | POST / DELETE | Set / remove the team avatar           |
| `/settings/user/:userId`         | DELETE     | Delete user completely                    |
| `/settings/users/:filter`        | GET        | Guest / orphan user lists                 |
| `/settings/server`               | GET / PUT  | Server-wide settings                      |
| `/settings/s3config`             | GET / PUT  | S3 storage configuration                  |
| `/settings/s3check`              | POST       | Test S3 connection                        |

Routes in `apps/api/src/routes/team.ts` and `apps/api/src/routes/settings.ts`. Team settings are stored in
`data/team/{teamId}/settings.json` via `TeamHome.settings` (`JsonStore<TeamSettings>`).

### User Deletion

One deletion semantic for every entry point. The complete teardown lives in `teardownUserData`
(`lib/user/delete-user.ts`), invoked from the `databaseHooks.user.delete.before` hook in `auth.ts` — the one
seam every better-auth deletion path passes through while the user row still exists:

1. Evicts cached Home singleton (closes databases)
2. Deletes home directory (`data/home/{userId}/`, or the guest home for guests)
3. Cleans share registry (entries FROM the user always; entries TO the user only for non-guests, so re-OTP
   after guest deletion rehydrates the same shared.db state)
4. Removes auth rows referencing the user — org/team memberships, 2FA, API keys — via
   `authDeleteUserReferences` (explicit deletion since SQLite CASCADE is inert with `PRAGMA foreign_keys` off).
   Membership deletion also sweeps rows whose user is already gone, healing orphans from past bad deletions

Entry points, all funneling through better-auth's `deleteUser` (sessions + accounts, then the user row, with
the hook firing before the user row goes):

- `DELETE /settings/user/:userId` — admin-only Eigen route; `deleteUserCompletely` delegates to
  `auth.api.removeUser()`
- better-auth's raw `POST /auth/admin/remove-user` — same complete teardown via the hook
- inactive-guest cleanup (system, no session) — `deleteUserCompletely(id, null)` goes through
  `auth.$context.internalAdapter.deleteUser()`

A hook error aborts better-auth's user-row deletion (fail-closed); sessions and accounts are already gone at
that point, so a retry of the deletion completes the removal.

Guards: cannot delete your own account and non-admins are rejected — enforced server-side by the Eigen route
(`requireAdmin` + own-account 400) and independently by better-auth's `/admin/remove-user` itself (403
non-admin, 400 self-removal), so the raw endpoint bypasses nothing.

**Frontend**: `useDeleteUser(organizationId)` hook in `packages/lib/src/core/admin/hooks/use-members.ts`.
"Danger zone" section in member detail with confirmation dialog.
