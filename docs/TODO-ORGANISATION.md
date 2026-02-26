# Organizations, Teams & Shared Drives — Implementation Plan

## Current State

Eigen is fully **per-user**. Every user gets a `Home` singleton with their own Drive, Mail, Contacts. Data lives at `data/home/{userId}/`. Sharing is email-based via `DriveACL` entries. better-auth's `organization()` plugin is registered and the schema tables (`organization`, `member`, `invitation`) exist in `auth-schema.ts` and `users3.db` — but nothing in Eigen uses them yet.

**Ownership model**: `Mount` has a fixed `ownerId` (the Home owner's user ID). All files/folders created through that mount inherit this `ownerId`. When Bob uploads a file to Alice's shared folder, `ownerId = alice.id`. This is correct — `ownerId` means "this file lives in Alice's storage space." If Alice deletes her account, all files in her mount are deleted regardless of who created them. This matches the Google Drive model.

**User deletion already works correctly**: Deleting Bob only removes `data/home/{bobId}/`. Files Bob created in Alice's folder live in `data/home/{aliceId}/` and are untouched.

---

## Design Goals

1. **Organization** = the Eigen instance (single-org, self-hosted)
2. **Teams** = ACL groups for sharing (e.g., share with "Engineering" instead of listing 10 emails)
3. **Shared Drives** = organization-owned storage (not tied to any individual, survives departures)
4. **Guest Access** = external users via Email OTP (see `docs/TODO-GUEST-USERS.md`)
5. **Unified routing** = all drive types use the same `/drive/:ownerId/:mountId/:pathId` URL pattern

---

## Core Mechanism: Prefixed Owner IDs

The key insight: `ownerId` currently assumes a user ID. To support org-owned and team-owned drives through the same route pattern, prefix the owner ID to encode its type:

```typescript
// packages/lib/src/types/owner.ts
export type OwnerType = 'user' | 'org' | 'team';

export function parseOwnerId(ownerId: string): { type: OwnerType; id: string } {
    if (ownerId.startsWith('org_')) return { type: 'org', id: ownerId.slice(4) };
    if (ownerId.startsWith('team_')) return { type: 'team', id: ownerId.slice(5) };
    return { type: 'user', id: ownerId.startsWith('user_') ? ownerId.slice(5) : ownerId };
}

export function userOwnerId(userId: string): string {
    return `user_${userId}`;
}

export function orgOwnerId(orgId: string): string {
    return `org_${orgId}`;
}

export function teamOwnerId(teamId: string): string {
    return `team_${teamId}`;
}
```

**Why this works:**
- All existing routes (`/drive/:ownerId/:mountId/folder/:pathId`) stay identical
- All FE hooks already pass `ownerId` as an opaque string
- `getSharedDrive()` becomes the single dispatch point based on prefix
- Deletion: delete user → removes `data/home/{userId}/`. Files in org/team drives (`ownerId = org_*`) are untouched
- Extensible: easy to add `project_` or `community_` later

**Note:** We are in dev mode — no backward compatibility needed, all data can be wiped.

---

## Route Resolution

Currently `getSharedDrive()` assumes `ownerId` is a user ID. Change it to dispatch based on prefix:

```typescript
// apps/api/src/lib/drive/get-drive.ts
export async function getSharedDrive(ownerId: string, user: User) {
    const parsed = parseOwnerId(ownerId);

    if (parsed.type === 'org') {
        const orgHome = await getOrgHome(parsed.id);
        return new SharedDrive(orgHome, user);
    }

    if (parsed.type === 'team') {
        const teamHome = await getTeamHome(parsed.id);
        return new SharedDrive(teamHome, user);
    }

    // User drive (existing logic, but use raw id)
    if (parsed.id !== user.id) {
        const owner = await getUserById(parsed.id);
        if (!owner) throw new ApiError(404, `Owner not found`);
        const home = await getHome(owner);
        return new SharedDrive(home, user);
    }
    return getDrive(user);
}
```

This is the **only** change needed in the route layer. All 30+ drive endpoints in `drive.ts` work unchanged because they all go through `getSharedDrive()`.

**How this composes with guest access** (`TODO-GUEST-USERS.md`):
- `getHome(user)` branches by role: guest → `GuestHome`, regular → `Home`
- `getSharedDrive(ownerId, user)` branches by prefix: user/org/team
- A guest accessing an org drive: `getSharedDrive("org_xyz", guestUser)` → checks ACL for `guestUser.email` → works if explicitly listed
- These are independent axes — no special guest-org interaction code needed

---

## Data Layout

```
data/
├── server/
│   ├── users3.db              # better-auth (users, sessions, orgs, members, teams)
│   ├── config.db              # System configuration
│   └── config.json            # Setup state
│
├── home/{userId}/             # Personal data (unchanged)
│   ├── mounts/
│   │   ├── default/
│   │   │   ├── metadata.db    # ownerId = user_{userId}
│   │   │   └── data/
│   │   └── shared.db
│   ├── eigen.mail/
│   └── eigen.contacts/
│
├── org/{orgId}/               # NEW: Organization data
│   └── drives/
│       └── {driveId}/
│           ├── metadata.db    # ownerId = org_{orgId}
│           ├── data/
│           └── thumbs/
│
└── team/{teamId}/             # NEW: Team data
    └── drives/
        └── {driveId}/
            ├── metadata.db    # ownerId = team_{teamId}
            ├── data/
            └── thumbs/
```

Add to `apps/api/src/lib/config/paths.ts`:
```typescript
export function getOrgDataPath(orgId: string): string {
    return path.join(getDataRoot(), 'org', orgId);
}

export function getTeamDataPath(teamId: string): string {
    return path.join(getDataRoot(), 'team', teamId);
}
```

---

## OrgHome & TeamHome

The guest user design (`TODO-GUEST-USERS.md`) already establishes polymorphic Home types: `GuestHome` extends `Home` with stateless overrides. But `OrgHome` is NOT a user — it doesn't need mail, contacts, or a user session. It's a standalone class:

```typescript
// apps/api/src/lib/home/org-home.ts
export class OrgHome {
    public orgId: string;
    public homeDir: string;
    public drive!: Drive;
    private managedDatabases: Map<string, () => Promise<ManagedDatabase<any>>> = new Map();
    private sseListeners: ((event: SSEvent) => void)[] = [];

    constructor(orgId: string) {
        this.orgId = orgId;
        this.homeDir = getOrgDataPath(orgId);
    }

    async init(): Promise<OrgHome> {
        // Create default mount with orgOwnerId
        this.drive = new Drive(this as any); // Drive only needs homeDir + getLocalDatabase + user.id
        // Override ownerId for mount creation
        await this.drive.init();
        return this;
    }

    // Same ManagedDatabase/SSE infrastructure as Home
    getLocalDatabase<S extends SchemaType>(config: DatabaseConfig<S>, relativePath: string): Promise<ManagedDatabase<S>> { ... }
    notify(event: SSEvent): void { ... }
}
```

`TeamHome` follows the same pattern but at `data/team/{teamId}/`.

**Singleton factories** matching the `getHome` pattern:

```typescript
// apps/api/src/lib/home/get-org-home.ts
const orgHomes: Map<string, () => Promise<OrgHome>> = new Map();

export function getOrgHome(orgId: string): Promise<OrgHome> {
    if (!orgHomes.has(orgId)) {
        orgHomes.set(orgId, createAsyncSingleton(async () => {
            const orgHome = new OrgHome(orgId);
            await orgHome.init();
            return orgHome;
        }));
    }
    return orgHomes.get(orgId)!();
}
```

**Possible future refactor:** Extract shared database/mount/SSE management from `Home` into a `DriveHost` base that both `Home`, `OrgHome`, and `TeamHome` use. Not needed now.

---

## ACL Integration

### Extend DriveACL Type

Add an optional `type` field. Defaults to `'user'` for full backward compatibility with existing ACL entries:

```typescript
// packages/lib/src/types/drive.ts
type DriveACLSubjectType = 'user' | 'team' | 'org';

type DriveACL = {
    email: string                  // email for users, teamId for teams, orgId for orgs
    type?: DriveACLSubjectType     // defaults to 'user'
    read: boolean
    write: boolean
}
```

Existing ACL entries (no `type` field) continue to work as user entries. No migration needed.

### Update canRead / canWrite

Add a membership resolver for team/org checks:

```typescript
// apps/api/src/lib/drive/acl.ts
type MembershipInfo = {
    orgIds: string[]
    teamIds: string[]
}

type MembershipResolver = (userId: string) => Promise<MembershipInfo>;

export async function canRead(
    path: DrivePath,
    user: User,
    getPath: PathGetter,
    getMemberships?: MembershipResolver
): Promise<boolean> {
    if (path.ownerId === user.id) return true;
    // Also check prefixed ownerId match
    if (path.ownerId === userOwnerId(user.id)) return true;
    if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

    // Check org-wide visibility
    if (path.visibility === 'org-read' || path.visibility === 'org-write') {
        if (getMemberships) {
            const memberships = await getMemberships(user.id);
            // Check user is in the org that owns this path
            const parsed = parseOwnerId(path.ownerId);
            if (parsed.type === 'org' && memberships.orgIds.includes(parsed.id)) return true;
        }
    }

    if (path.acl) {
        for (const acl of path.acl) {
            if (!acl.read) continue;
            const type = acl.type || 'user';
            if (type === 'user' && acl.email.toLowerCase() === user.email.toLowerCase()) return true;
        }

        // Check team/org ACLs (lazy resolve)
        if (getMemberships) {
            const memberships = await getMemberships(user.id);
            for (const acl of path.acl) {
                if (!acl.read) continue;
                const type = acl.type || 'user';
                if (type === 'team' && memberships.teamIds.includes(acl.email)) return true;
                if (type === 'org' && memberships.orgIds.includes(acl.email)) return true;
            }
        }
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canRead(parent, user, getPath, getMemberships);
    }

    return false;
}
```

**Performance:** Cache memberships per-request (not per `canRead` call, since it recurses up the tree):

```typescript
function createCachedResolver(resolver: MembershipResolver): MembershipResolver {
    const cache = new Map<string, Promise<MembershipInfo>>();
    return (userId) => {
        if (!cache.has(userId)) cache.set(userId, resolver(userId));
        return cache.get(userId)!;
    };
}
```

### Visibility Extension

```typescript
type DriveVisibility = 'private' | 'org-read' | 'org-write' | 'public-read' | 'public-write';
```

| Value | Who can access |
|-------|---------------|
| `private` | Only named users/teams + owner |
| `org-read` | Any member of the owner's organization can read |
| `org-write` | Any member of the owner's organization can read + write |
| `public-read` | Anyone with the link (including guests/anonymous) |
| `public-write` | Anyone with the link can edit |

### ACL Propagation for Teams

When sharing with a team, `acl-propagation.ts` resolves team members:

```typescript
// apps/api/src/lib/drive/acl-propagation.ts
export async function propagateACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
    const emails = new Set<string>();

    for (const acl of [...(oldACL || []), ...(newACL || [])]) {
        const type = acl.type || 'user';
        if (type === 'user') {
            emails.add(acl.email);
        } else if (type === 'team') {
            const members = await getTeamMembers(acl.email); // teamId
            for (const m of members) emails.add(m.email);
        } else if (type === 'org') {
            const members = await getOrgMembers(acl.email); // orgId
            for (const m of members) emails.add(m.email);
        }
    }

    for (const email of emails) {
        // ... existing propagation logic
    }
}
```

**Edge case — team membership changes:** When a user is added/removed from a team, paths shared with that team need re-propagation. Implementation: listen for team membership changes (better-auth hooks or poll) → query shared.db for paths with `type: 'team', email: teamId` → re-propagate. Rare enough to handle lazily.

---

## better-auth Configuration

### Enable Teams

```typescript
// apps/api/src/lib/auth/auth.ts
organization({
    teams: { enabled: true }
})
```

This adds:
- `team` table (id, name, organizationId, createdAt, updatedAt) → add to `auth-schema.ts`
- `teamMember` table (id, teamId, userId, role, createdAt) → add to `auth-schema.ts`
- Client APIs: `authClient.organization.createTeam()`, `listTeams()`, `addTeamMember()`, etc.

### Auto-Create Default Organization

During setup wizard (`apps/api/src/lib/setup/setup.ts`), after creating the admin user:

```typescript
// In completeSetup(), after creating admin user:
const org = await auth.api.createOrganization({
    body: {
        name: input.domain,
        slug: input.domain.replace(/\./g, '-'),
    },
    headers: { /* admin session */ }
});

// Add admin as owner of the organization
await auth.api.addMember({
    body: {
        organizationId: org.id,
        userId: user.user.id,
        role: 'owner',
    }
});
```

### Auto-Add New Users to Default Organization

Add a `databaseHooks.user.create.after` hook in auth config:

```typescript
databaseHooks: {
    user: {
        create: {
            after: async (user) => {
                if (user.role !== 'guest') {
                    const defaultOrg = await getDefaultOrganization();
                    if (defaultOrg) {
                        await addMemberToOrg(defaultOrg.id, user.id, 'member');
                    }
                }
            }
        }
    }
}
```

---

## Share Dialog UI Changes

The share dialog (`packages/ui/src/components/layout/drive/drive-access-list-edit.tsx`) needs to support teams:

- **"Add people or teams"** input → autocomplete that shows both users and teams
- Team entries display with a group icon and team name
- Team ACL entries stored as `{type: 'team', email: teamId, read: true, write: true}`
- Inherited team access shows "Inherited from [folder] via [team name]"

The `ContactAutosuggest` component needs extension to also search teams via `authClient.organization.listTeams()`.

---

## Guest Users Integration

See `docs/TODO-GUEST-USERS.md` for the full guest auth plan. Key integration points:

### How Guest Access Works with Org/Team Drives

The guest auth flow validates ACL before sending an OTP. This works for org drives without changes:

1. Guest clicks link: `https://eigen.is/drive/s/org_abc123/engineering/file-uuid?email=guest@external.com`
2. `POST /guest-auth/create-guest` receives `{email, ownerId: "org_abc123", mountId: "engineering", pathId: "file-uuid"}`
3. `parseOwnerId("org_abc123")` → resolves to org drive
4. ACL check: guest email must be explicitly listed in the file's ACL
5. Guest gets OTP → verifies → accesses the file via standard `getSharedDrive("org_abc123", guestUser)` flow

**Guests have no org membership.** They only access paths where their email is explicitly in the ACL:
- `org-read`/`org-write` visibility → guest fails (not an org member) → falls through to email ACL check
- Explicit email ACL → guest matches → access granted
- Team ACL → guest has no teams → fails

### Visibility vs Authentication Matrix

| Visibility | Who sees it | Auth required? | Route |
|-----------|-------------|---------------|-------|
| `private` | Named users/teams only | Yes (session) | `/drive/...` |
| `org-read/write` | Org members | Yes (session + org membership) | `/drive/...` |
| `public-read/write` | Anyone with the link | **No** (anonymous) or Yes (guest OTP) | `/p/drive/...` |
| ACL with external email | Specific external person | Yes (guest OTP) | `/drive/...` (after OTP login) |

### Update to TODO-GUEST-USERS.md

The guest auth `create-guest` endpoint needs to handle prefixed owner IDs:

```typescript
// In /guest-auth/create-guest handler:
const parsed = parseOwnerId(ownerId);
let drive;
if (parsed.type === 'org') {
    const orgHome = await getOrgHome(parsed.id);
    drive = orgHome.drive;
} else if (parsed.type === 'team') {
    const teamHome = await getTeamHome(parsed.id);
    drive = teamHome.drive;
} else {
    const owner = await getUserById(parsed.id);
    if (!owner) throw new ApiError(404, 'Owner not found');
    const home = await getHome(owner);
    drive = home.drive;
}
const hasAccess = await drive.canRead(mountId, pathId, { id: 'guest-check', email } as User);
```

---

## Edge Cases

### Team membership change
**Problem**: Alice shares folder X with Team "Engineering". Bob joins Engineering. Does Bob immediately see folder X?
**Answer**: At permission-check time, yes — `canRead` resolves team membership live. For "Shared with me" (Bob's `shared.db`), a background job must detect the membership change and propagate. This can be event-driven (better-auth hooks) or lazy (check on next shared-with-me query).

### User leaves organization
**Problem**: Alice leaves the org. What happens to her personal data?
**Answer**: Her personal Home (`data/home/{aliceId}/`) stays intact. Admin can:
- Transfer ownership of her files to another user (future feature)
- Delete her account (cascades via better-auth)
- Her data in org-owned drives is unaffected (not tied to her, `ownerId = org_*`)

### Nested teams
**Problem**: Can teams contain other teams?
**Answer**: better-auth teams are flat (within an organization). No nesting. This keeps ACL resolution simple — one lookup, no recursion. If nested groups are needed later, implement as a custom layer on top.

### Team ACL + individual ACL on same path
**Problem**: Bob has read-only via Team "Design", but Alice gives Bob explicit write access on the same folder.
**Answer**: Purely additive, same as current model. `canWrite` finds `write: true` for Bob in individual ACL → returns `true`. Team ACL doesn't reduce it.

### Sharing with team you're not a member of
**Problem**: Can Alice share her folder with Team "Sales" even though she's not in Sales?
**Answer**: Yes. Alice owns her folder. The ACL just records `{type: 'team', email: salesTeamId, read: true}`. Same as how you can share with any email today.

### Org-read visibility on deeply nested file
**Problem**: Folder A is `private`. Subfolder B is `org-read`. Can org members see B?
**Answer**: Yes. `canRead` checks B's visibility first → `org-read` → checks org membership → grants read. The parent's `private` visibility doesn't block it because visibility is checked per-path, not inherited. Consistent with how `public-read` already works.

### Guest user + team-shared path
**Problem**: A path is shared with Team "Engineering". A guest user tries to access it.
**Answer**: Guest has no team memberships. Team ACL check fails. Individual ACL check fails. Parent check runs. If no ancestor grants access, denied. Correct — guests only access paths where their email is explicitly listed.

### Deleting an organization
**Problem**: What happens to org drives when the org is deleted?
**Answer**: `data/org/{orgId}/` is deleted, along with all its drives and files. All `shared.db` entries with `ownerId = org_{orgId}` in any user's shared database become stale and should be cleaned up (background job or lazy check).

---

## Implementation Phases

### Phase 1: Prefixed Owner IDs + Foundation

**Goal**: All drives use prefixed owner IDs. No new functionality yet, just the type system.

| # | Task | Files |
|---|------|-------|
| 1 | Create `packages/lib/src/types/owner.ts` with `parseOwnerId`, `userOwnerId`, `orgOwnerId`, `teamOwnerId` | `packages/lib/` |
| 2 | Export from `packages/lib/src/types/index.ts` | `packages/lib/` |
| 3 | Update `Drive.addMount()` to pass `userOwnerId(user.id)` instead of raw `user.id` | `apps/api/src/lib/drive/drive.ts` |
| 4 | Update `canRead`/`canWrite` `ownerId` comparison to handle prefixed IDs | `apps/api/src/lib/drive/acl.ts` |
| 5 | Update `getSharedDrive()` to use `parseOwnerId` for routing | `apps/api/src/lib/drive/get-drive.ts` |
| 6 | Add `getOrgDataPath`, `getTeamDataPath` to paths.ts | `apps/api/src/lib/config/paths.ts` |
| 7 | Wipe test data, update all drive tests for prefixed IDs | `apps/api/src/test/` |

### Phase 2: Organization Infrastructure

**Goal**: Default organization exists. All users are members.

| # | Task | Files |
|---|------|-------|
| 1 | Add `team`/`teamMember` tables to `auth-schema.ts` | `apps/api/auth-schema.ts` |
| 2 | Enable `teams: { enabled: true }` in `organization()` plugin | `apps/api/src/lib/auth/auth.ts` |
| 3 | Add team/teamMember schema to auth config | `apps/api/src/lib/auth/auth.ts` |
| 4 | Create default org in `completeSetup()` | `apps/api/src/lib/setup/setup.ts` |
| 5 | Add admin as org owner in setup | `apps/api/src/lib/setup/setup.ts` |
| 6 | Auto-add new users to default org (database hook) | `apps/api/src/lib/auth/auth.ts` |
| 7 | Add `initializeDatabaseSchema()` DDL for team/teamMember | `apps/api/src/lib/setup/setup.ts` |
| 8 | Add team management API routes | `apps/api/src/routes/admin.ts` or new `teams.ts` |
| 9 | Update tests: setup creates org, new users auto-join | `apps/api/src/test/` |

### Phase 3: OrgHome + Shared Drives

**Goal**: Organization-owned drives that are not tied to any individual.

| # | Task | Files |
|---|------|-------|
| 1 | Create `OrgHome` class | `apps/api/src/lib/home/org-home.ts` |
| 2 | Create `getOrgHome()` factory | `apps/api/src/lib/home/get-org-home.ts` |
| 3 | Create `TeamHome` class (same pattern) | `apps/api/src/lib/home/team-home.ts` |
| 4 | Create `getTeamHome()` factory | `apps/api/src/lib/home/get-team-home.ts` |
| 5 | Update `getSharedDrive()` to handle `org_`/`team_` prefixes | `apps/api/src/lib/drive/get-drive.ts` |
| 6 | Add admin routes for creating/managing org drives | `apps/api/src/routes/admin.ts` |
| 7 | Add admin routes for creating/managing team drives | `apps/api/src/routes/admin.ts` |
| 8 | Add tests for org/team drives: create, upload, read, ACL | `apps/api/src/test/` |

### Phase 4: Teams + ACL Integration

**Goal**: Share with teams. Org-wide visibility.

| # | Task | Files |
|---|------|-------|
| 1 | Extend `DriveACL` type with optional `type` field | `packages/lib/src/types/drive.ts` |
| 2 | Extend `DriveVisibility` with `org-read`/`org-write` | `packages/lib/src/types/drive.ts` |
| 3 | Add `MembershipResolver` to `canRead`/`canWrite` | `apps/api/src/lib/drive/acl.ts` |
| 4 | Implement `getMemberships()` querying better-auth tables | `apps/api/src/lib/users/` |
| 5 | Wire cached membership resolver into `Drive` class | `apps/api/src/lib/drive/drive.ts` |
| 6 | Update ACL propagation to resolve teams/orgs to members | `apps/api/src/lib/drive/acl-propagation.ts` |
| 7 | Update ACL validation in route to accept `type` field | `apps/api/src/routes/drive.ts` |
| 8 | Add tests: team ACL, org visibility, team membership changes | `apps/api/src/test/` |

### Phase 5: Frontend

**Goal**: UI for team sharing, org drives, team management.

| # | Task | Files |
|---|------|-------|
| 1 | Update share dialog to show teams in autocomplete | `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` |
| 2 | Add team ACL display (group icon, team name) | `packages/ui/` |
| 3 | Add "Shared Drives" section in Drive app sidebar | `apps/drive/` |
| 4 | Add org drive browsing (same DriveLayout, different ownerId) | `apps/drive/` |
| 5 | Add team management UI in Admin panel | `apps/admin/` |
| 6 | Update breadcrumb to show org/team drive names | `packages/ui/` |
| 7 | Add visibility dropdown with `org-read`/`org-write` options | `packages/ui/` |

### Phase 6: Guest Access Integration

**Goal**: Guest users can access org/team drive resources via OTP.

See `docs/TODO-GUEST-USERS.md` for the full plan. Additional changes:

| # | Task | Files |
|---|------|-------|
| 1 | Update `create-guest` endpoint to handle prefixed `ownerId` | `apps/api/src/routes/guest-auth.ts` |
| 2 | Ensure `GuestHome` factory in `getHome()` works with `SharedDrive` on org/team drives | `apps/api/src/lib/home/get-home.ts` |
| 3 | Add tests: guest access to org drive, guest denied org-read visibility | `apps/api/src/test/guest.test.ts` |

---

## Summary

| Feature | Mechanism | Phase |
|---------|-----------|-------|
| Prefixed owner IDs | `user_`, `org_`, `team_` prefix on `ownerId` | 1 |
| Organizations | better-auth `organization()` plugin, auto-created on setup | 2 |
| Teams | better-auth `teams` feature, flat within org | 2 |
| Share with team | `DriveACL.type = 'team'` | 4 |
| Org-wide visibility | `DriveVisibility = 'org-read' \| 'org-write'` | 4 |
| Org-owned drives | `OrgHome` class + `data/org/` directory | 3 |
| Team-owned drives | `TeamHome` class + `data/team/` directory | 3 |
| Guest access to org drives | `parseOwnerId` in `create-guest` endpoint | 6 |
| Public URLs | `/p/drive/...` routes, no auth (see `TODO-GUEST-USERS.md`) | 6 |

The design is **additive** — no existing behavior changes. Personal data stays per-user. The organization layer adds team-based sharing, org-level visibility, and shared drives on top. better-auth handles identity plumbing (membership, invitations, roles). Eigen only extends ACL resolution, adds the `OrgHome`/`TeamHome` classes, and prefixes owner IDs for routing.
