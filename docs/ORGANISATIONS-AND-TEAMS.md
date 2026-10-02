# Organizations & Teams

> **TLDR:** Eigen is single-org and self-hosted: setup creates one organization and every user joins it. Teams are flat groups inside it, used as ACL groups and as owners of shared drives (`TeamHome`). The data model is better-auth's `organization()` plugin (`apps/api/src/lib/auth/auth.ts`), and owner IDs carry their type as a prefix: a bare id is a user, `team_` a team, `org_` the org. Not obvious from the code: teams have no roles of their own, so managing a team is an org admin's job; team routes want the prefixed `team_` id; the org owner is out of reach of the admin plugin; and every way to delete a user runs one teardown.

Users, the org, its members and its teams are rows in one server-wide auth database that better-auth manages (`users3.db` in `data/server/`). The rest of Eigen meets them in three places. Each user and each team owns a Home, the folder that holds its data ([STORAGE.md § A Home is loaded on demand](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)), and every route names the Home it acts on by its owner id. The ACL takes a team as one more kind of entry, so **Share with team** reaches whoever is in the team today ([ACL.md](ACL.md)). And the org role decides who may use the Admin app (`apps/admin/`), where admins add people, teams and team drives.

## One org, created at setup, and everyone joins it

Setup creates the organization with a system call (`auth.api.createOrganization` with no session) and pins its id in the server config. `allowUserToCreateOrganization: false` blocks every other creation, so a user can't spin up an org they own and escalate past `requireAdmin`. The plugin runs with teams enabled and the `apiKey()` plugin beside it. Its default 100-member cap is lifted (`membershipLimit`), because the cap fails every user creation past the hundredth in the create hook.

Every new non-guest user joins as `member` in `databaseHooks.user.create.after`, which also runs share reconciliation ([ACL.md § Reconciliation](ACL.md#reconciliation)). Every sign-in re-attempts the join when the membership row is missing (`authEnsureDefaultOrgMembership` from `databaseHooks.session.create.after`). The sign-up join only logs a failure, so sign-in is its repair path: without it, an account whose join failed stays outside the org and invisible in Admin → Users. Guests never join ([GUEST-ACCESS.md](GUEST-ACCESS.md)).

## The owner holds server settings and admins manage people

| Role     | Can                                             |
|----------|-------------------------------------------------|
| `owner`  | Everything an admin can, plus the server settings, S3 config, waitlist, onboarding and whole-server backups. The setup admin |
| `admin`  | Users, teams, team drives, guests and per-home backups |
| `member` | Default. Uses the shared drives their teams own |

`requireAdmin` and `requireOwner` (`apps/api/src/lib/core/access.ts`) read the org role. Which settings route is whose, and the Admin app's `_owner` guard, are in [SERVER-SETTINGS.md](SERVER-SETTINGS.md#settings-are-the-owners-the-pages-admins-need-are-theirs-too).

## The owner is out of reach of the admin plugin

Every org admin also holds better-auth's `user.role: 'admin'`, which lets the admin plugin act on any user past Eigen's own checks. So `/admin/impersonate-user` is in `disabledPaths`, and a `hooks.before` on `/admin/*` (`apps/api/src/lib/auth/auth.ts`) refuses a call that targets the owner unless the owner makes it. An admin can neither demote, delete, rename nor sign in as the owner. Eigen's own routes hold the same line: deleting the owner answers 400, and only the owner resets the owner's password ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#an-admin-password-reset-revokes-every-way-in)).

## Teams are flat groups with no roles

A team serves two purposes: an ACL group (share with `team_{id}` instead of emails) and the owner of shared drives. A team member row has no role, so every member is equal. Adding a member runs `reconcileSharesForNewTeamMember`, which delivers the shares already made to the team.

Team routes (`apps/api/src/routes/team.ts`) use two guards from `apps/api/src/lib/core/access.ts`. `requireTeamAccess` lets an org admin or owner in without membership and otherwise demands membership of that team; members may read the team's members, settings and mounts. `requireTeamAdmin` demands org admin or owner, so only they change team settings, mounts, calendar and avatar.

## Every team route takes the prefixed team id

Team routes take `:ownerId` in its `team_{teamId}` form, not the bare team id. Every route parses it first (`teamId()` in `apps/api/src/routes/team.ts`) and answers 400 to an id that is not a team id, since `parseOwnerId` reads a bare id as a *user* id. Build the segment with `teamOwnerId(teamId)`. `useTeamMembers(teamId)` (`packages/lib/src/core/team/hooks/`) takes the raw id and wraps it itself.

## A team drive starts empty and its calendar starts off

`TeamHome` (`apps/api/src/lib/home/team-home.ts`) runs as a synthetic user with id `team_{teamId}` and holds a Drive and a Calendar, with no mail, contacts or notifications. Its folder and idle window are in [STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle). It starts with zero mounts: an admin adds each drive from the Admin app (`TeamHome.addMount`). The calendar is off until an admin turns it on (`settings.calendar.enabled`), and while off the calendar getter answers 404. Team settings live in the team's `settings.json` (`JsonStore<TeamSettings>`).

No team user ever logs in, so team members always reach team data through `SharedDrive`, where they count as co-owners ([ACL.md § Design Decisions](ACL.md#design-decisions)).

## A team avatar is one file, and the admin page busts its cache

Org admins set a team avatar from the admin team detail page (`POST`/`DELETE /team/:ownerId/avatar`, gated by `requireTeamAdmin`). Storage mirrors the user-avatar pipeline: one webp at `data/server/avatars/team_{teamId}.webp`, written via `pushTeamAvatar` in `home-relay.ts`. File existence is the only source of truth: no settings pointer, no schema column. Deleting the team removes the file (`afterDeleteTeam`). Serving goes through `GET /p/avatar/team_{teamId}`, falling back to the deterministic team SVG, with the same 24h public `Cache-Control` as user avatars.

The team filename is stable, unlike the per-upload UUID of a user avatar, so the editing surface would show the browser-cached copy. The admin team detail page appends a client-generated `?v={timestamp}` on mount, on team switch, and after upload or remove. A `?v` value must never repeat across page loads, because a repeated value serves the stale cache entry: never use a counter. Other surfaces accept up to 24h of staleness.

## An owner ID says which kind of home it names

Every drive route is `/drive/:ownerId/:mountId/...`, and `ownerId` encodes the type. `parseOwnerId` (`packages/lib/src/types/owner.ts`) reads it:

| Type | Format          | Home |
|------|-----------------|------|
| User | 32-character auth id (an email also parses as a user) | `UserHome`, or `GuestHome` for a guest |
| Team | `team_{teamId}` | `TeamHome` |
| Org  | `org_{orgId}`   | `OrgHome` |

It also knows `external_` (a calendar organizer outside Eigen) and flags anything else `invalid`, which `getHome` answers with 400. Build ids with `userOwnerId`, `teamOwnerId` and `orgOwnerId`.

`getHome(ownerId)` (`apps/api/src/lib/home/get-home.ts`) dispatches on the type and checks that the user, team or org exists. `getSharedDrive(ownerId, user)` (`apps/api/src/lib/drive/get-drive.ts`) hands the owner their own `Drive` and wraps any other home in a `SharedDrive`.

`OrgHome` has no services, only its folder. The one `org_` id the code builds is the whole-server backup's: its jobs and its manifest carry `orgOwnerId(orgId)` as their owner (`apps/api/src/lib/backup/server-job.ts`), and nothing resolves a Home from it.

## A team ACL entry resolves through memberships

A team entry is `{ id: 'team_xyz', read: true, write: false }`. `canRead` and `canWrite` parse it and check `getMemberships(userId)` (`apps/api/src/lib/user/user.ts`), which returns `{ orgIds, teamIds }`. `filterRedundantACL()` drops a team entry on a path that team owns. The rest of the model is in [ACL.md](ACL.md).

## The Admin app is for org admins and owners

`apps/admin/` manages members and teams through better-auth's client (`authClient.organization.*`) and everything else through Eden. The route guard in `_auth.tsx` fetches the org members and shows an access-denied `EmptyState` to anyone who is not `admin` or `owner`. The app switcher shows "Admin" only to them. The admin hooks are in `packages/lib/src/core/admin/hooks/` and the team hooks in `packages/lib/src/core/team/hooks/`. What each page does for the user is in the help center (`apps/index/src/data/support/admin/`).

The Users page (`GET /settings/users`) lists org members **and** orphans, non-guest accounts with no membership in the org, so an orphan is visible and can be deleted from its detail pane. `/members` redirects to `/users`.

## Deleting a user runs one teardown from every entry point

`teardownUserData` (`apps/api/src/lib/user/delete-user.ts`) runs from the `databaseHooks.user.delete.before` hook in `auth.ts`, the one hook every better-auth deletion path passes through while the user row still exists:

1. Evicts the cached Home (closes its databases)
2. Deletes the home folder (`data/home/{userId}/`, or the guest home for a guest)
3. Cleans the share registry: the entries the user created always, the entries addressed to the user only for a non-guest, so a guest who signs in again gets the same shares back ([GUEST-ACCESS.md](GUEST-ACCESS.md#the-share-registry-is-a-durable-record-not-a-queue))
4. Removes the auth rows that reference the user (org and team memberships, 2FA, API keys) through `authDeleteUserReferences`. The deletion is explicit because SQLite's CASCADE does nothing with `PRAGMA foreign_keys` off, and a leftover member row 500s `listMembers` org-wide. The org and team membership deletes also remove every row whose user no longer exists

Every entry point funnels through better-auth's `deleteUser` (sessions and accounts, then the user row, with the hook firing before the user row goes):

- `DELETE /settings/user/:userId`: the admin route, where `deleteUserCompletely` delegates to `auth.api.removeUser()`
- better-auth's raw `POST /auth/admin/remove-user`: the same teardown through the hook
- inactive-guest cleanup (system, no session): `deleteUserCompletely(id, null)` goes through `auth.$context.internalAdapter.deleteUser()`

A hook error aborts the user-row deletion (fail-closed). Sessions and accounts are already gone at that point, so retrying the deletion completes it.

The guards hold on both routes. The Eigen route has `requireAdmin`, a 400 for your own account and a 400 for the owner. better-auth's `/admin/remove-user` rejects a non-admin (403) and self-removal (400) itself, and `hooks.before` keeps it off the owner, so the raw endpoint bypasses nothing. The frontend is `useDeleteUser(organizationId)` in `packages/lib/src/core/admin/hooks/use-members.ts`, behind a confirmation in the user's danger zone.

## See also

- [ACL.md](ACL.md): sharing, team entries and reconciliation
- [GUEST-ACCESS.md](GUEST-ACCESS.md): guests, who never join the org
- [STORAGE.md](STORAGE.md): homes, their folders and idle windows
- [SERVER-SETTINGS.md](SERVER-SETTINGS.md): the owner's settings and the admin routes
