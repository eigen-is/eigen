# Organizations & Groups — Design Proposal

## Current State

Eigen is fully **per-user**. Every user gets a `Home` singleton with their own Drive, Mail, Contacts. Data lives at `data/home/{userId}/`. Sharing is email-based via `DriveACL` entries. better-auth's `organization()` plugin is already registered and the schema tables (`organization`, `member`, `invitation`) exist in `auth-schema.ts` and `users3.db` — but nothing in Eigen uses them yet.

---

## Google Workspace Model (Inspiration)

Google Workspace has three layers:

| Concept | What it does |
|---------|-------------|
| **Organization** | The company/domain. All `@acme.com` users belong to it. Has admin console, policies, billing. |
| **Groups** | Email-based groups (`engineering@acme.com`). Used for ACL shortcuts. Can be nested. |
| **Shared Drives** | Organization-owned storage. Not tied to any individual. Data survives employee departures. |

Key behaviors:
- You can share with a **user**, a **group**, or **"anyone in the organization"**
- Shared Drives have their own ACL — members are org users with roles (Manager, Content Manager, Contributor, Viewer)
- Personal Drive ("My Drive") is per-user, just like Eigen today
- Visibility options: Restricted / Anyone in org / Anyone with the link

---

## Proposed Design

### Core Principle: Keep personal data per-user. Add organization-level features on top.

### 1. Organization = The Eigen Instance

For a self-hosted tool, the simplest model: **one organization per Eigen instance**. The admin who runs setup creates the default organization. All registered users are automatically members.

If multi-org is needed later (e.g., MSP hosting multiple clients), the better-auth plugin already supports it — but for now, assume single-org.

```
data/
├── server/          # Global (users3.db, config.db)
├── home/{userId}/   # Personal data (unchanged)
└── org/{orgId}/     # NEW: Organization-owned data
    └── drives/
        └── {driveId}/
            ├── metadata.db
            └── data/
```

### 2. Teams (Groups) via better-auth

Use better-auth's **Teams** feature (nested inside organizations). Teams map directly to "Groups" in Google Workspace terms.

```typescript
// Enable in auth.ts
organization({
    teams: { enabled: true }
})
```

This gives us:
- `team` table (id, name, organizationId, createdAt, updatedAt)
- `teamMember` table (id, teamId, userId, role, createdAt)
- Client APIs: `authClient.organization.createTeam()`, `listTeams()`, `addTeamMember()`, etc.
- `session.activeOrganizationId` already on session schema

**No custom tables needed for group management.**

### 3. ACL Integration

#### Extend DriveACL

Add an optional `type` field. Defaults to `'user'` for full backward compatibility:

```typescript
type DriveACLSubjectType = 'user' | 'team' | 'org'

type DriveACL = {
    email: string                  // email for users, teamId for teams, orgId for orgs
    type?: DriveACLSubjectType     // defaults to 'user' (backward compat with existing data)
    read: boolean
    write: boolean
}
```

Existing ACL entries (no `type` field) continue to work as individual user entries. No migration needed.

#### ACL Resolution in `canRead` / `canWrite`

The permission check needs a membership resolver:

```typescript
type MembershipInfo = {
    orgIds: string[]      // organizations the user belongs to
    teamIds: string[]     // teams the user belongs to
}

type MembershipResolver = (userId: string) => Promise<MembershipInfo>

export async function canRead(
    path: DrivePath,
    user: User,
    getPath: PathGetter,
    getMemberships: MembershipResolver  // NEW parameter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;
    if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

    if (path.acl) {
        for (const acl of path.acl) {
            if (!acl.read) continue;

            const type = acl.type || 'user';
            if (type === 'user' && acl.email.toLowerCase() === user.email.toLowerCase()) return true;
            // Group/org checks deferred to membership lookup below
        }

        // Check team/org ACLs
        const memberships = await getMemberships(user.id);
        for (const acl of path.acl) {
            if (!acl.read) continue;
            const type = acl.type || 'user';
            if (type === 'team' && memberships.teamIds.includes(acl.email)) return true;
            if (type === 'org' && memberships.orgIds.includes(acl.email)) return true;
        }
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canRead(parent, user, getPath, getMemberships);
    }

    return false;
}
```

#### Performance: Cache Memberships

The `MembershipResolver` should cache per-request or per-session. Since `canRead`/`canWrite` are called recursively up the tree, the membership lookup should happen **once** and be reused:

```typescript
function createCachedResolver(resolver: MembershipResolver): MembershipResolver {
    const cache = new Map<string, Promise<MembershipInfo>>();
    return (userId) => {
        if (!cache.has(userId)) cache.set(userId, resolver(userId));
        return cache.get(userId)!;
    };
}
```

The `Drive` class creates a cached resolver at the start of each request, not per `canRead` call.

#### Visibility Extension

Add `org-read` and `org-write` to align with Google Workspace:

```typescript
type DriveVisibility = 'private' | 'org-read' | 'org-write' | 'public-read' | 'public-write'
```

| Value | Who can access |
|-------|---------------|
| `private` | Only named users/teams + owner |
| `org-read` | Any member of the owner's organization can read |
| `org-write` | Any member of the owner's organization can read + write |
| `public-read` | Anyone with the link (including guests/anonymous) |
| `public-write` | Anyone with the link can edit |

### 4. Organization-Owned Drives (Shared Drives)

This is the biggest new concept. A Shared Drive is **not** owned by any individual — it's owned by the organization.

#### Data Model

Create an `OrgHome` class (similar to `Home` but for org-level data):

```typescript
class OrgHome {
    orgId: string
    fs: LocalStorage              // data/org/{orgId}/
    drives: Map<string, Mount>    // org-level drives

    async init(): Promise<void>
    async createDrive(name: string, members: DriveACL[]): Promise<Mount>
}
```

#### How it works

- Org drives live at `data/org/{orgId}/drives/{driveId}/`
- Each org drive has its own `metadata.db` and `data/` storage — same Mount system as personal drives
- ACL on the drive root determines who can access it (typically teams or individual members)
- The `ownerId` on paths inside an org drive is the `orgId`, not a user ID
- Route pattern: `/drive/org/{orgId}/{driveId}/...` (vs personal `/drive/{userId}/{mountId}/...`)

#### Factory

```typescript
// get-org-home.ts
const orgHomes: Map<string, () => Promise<OrgHome>> = new Map();

export function getOrgHome(orgId: string): Promise<OrgHome> {
    // Similar singleton pattern as getHome()
}
```

#### When to build this

**Phase 2.** This is significant new infrastructure. Start with teams + ACL integration first (Phase 1). Org drives can come later when there's actual demand.

### 5. Share Dialog UI Changes

The share dialog (`drive-access-list-edit.tsx`) needs to support sharing with teams:

- **Add people or teams** input → autocomplete that shows both users and teams
- Team entries display with a group icon and team name
- Team ACL entries show as `{type: 'team', email: teamId, read: true, write: true}`
- Inherited team access shows "Inherited from [folder] via [team name]"

The `ContactAutosuggest` component needs extension to also search teams.

### 6. ACL Propagation for Teams

When sharing with a team, `acl-propagation.ts` needs to resolve the team to its members:

```typescript
export async function propagateACLChange(
    path: DrivePath,
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null
): Promise<void> {
    const emails = new Set<string>();

    for (const acl of [...(oldACL || []), ...(newACL || [])]) {
        const type = acl.type || 'user';
        if (type === 'user') {
            emails.add(acl.email);
        } else if (type === 'team') {
            const members = await getTeamMembers(acl.email);
            for (const m of members) emails.add(m.email);
        } else if (type === 'org') {
            const members = await getOrgMembers(acl.email);
            for (const m of members) emails.add(m.email);
        }
    }

    for (const email of emails) {
        // ... existing propagation logic
    }
}
```

**Edge case: Team membership changes.** When a user is added to or removed from a team, all paths with that team in their ACL need re-propagation. This requires a background scan — but it's rare enough to be acceptable.

Implementation: Listen for team membership changes (better-auth hooks or polling) → query all paths with `type: 'team', email: teamId` in their ACL → re-propagate.

---

## Guest Users & Public Access Integration

See `docs/TODO-GUEST-USERS.md` for the full guest auth plan. Here's how it connects:

### Visibility vs Authentication Matrix

| Visibility | Who sees it | Auth required? | Route |
|-----------|-------------|---------------|-------|
| `private` | Named users/teams only | Yes (session) | `/drive/...` |
| `org-read/write` | Org members | Yes (session + org membership) | `/drive/...` |
| `public-read/write` | Anyone with the link | **No** (anonymous) or Yes (guest OTP) | `/p/drive/...` |
| ACL with external email | Specific external person | Yes (guest OTP) | `/drive/...` (after OTP login) |

### Public URLs (`/p/` routes)

For `public-read` and `public-write` paths, add unauthenticated endpoints:

```typescript
// public.ts (extend existing)
.get("/p/drive/:ownerId/:mountId/file/:pathId", async ({ params }) => {
    const home = await getHomeById(params.ownerId);
    const path = await home.drive.getPath(params.mountId, params.pathId);
    if (!path) throw new ApiError(404, 'Not found');
    if (path.visibility !== 'public-read' && path.visibility !== 'public-write') {
        throw new ApiError(403, 'Not public');
    }
    return home.drive.getFileContent(params.mountId, params.pathId);
})
```

**Share links format**: `https://eigen.is/p/drive/{ownerId}/{mountId}/{pathId}`

For Docs/Stickies with `public-read`: render a read-only viewer (no Yjs connection).
For Docs/Stickies with `public-write`: full collab (anonymous cursor names?).

### Guest Users in Context of Orgs

Guests (OTP-authenticated external users):
- Are **not** members of any organization
- Can only access paths where their email is explicitly in the ACL
- Cannot see `org-read`/`org-write` paths (they're not org members)
- Have `role: 'guest'` — the `Home` factory returns `GuestHome` (stateless)

This means the ACL resolution is clean:
1. `visibility: org-*` → check org membership → guests fail → fall through to explicit ACL check
2. Explicit email ACL → guests can match → access granted

---

## Implementation Phases

### Phase 1: Teams + ACL (Medium effort)

**Goal**: Share with teams instead of listing every email individually.

1. **Enable better-auth teams**: Add `teams: { enabled: true }` to `organization()` config
2. **Auto-create default org**: During setup wizard, create the organization. All existing users become members.
3. **Auto-add new users**: On user registration, auto-add to default org as member.
4. **Extend `DriveACL` type**: Add optional `type` field.
5. **Update `canRead`/`canWrite`**: Add membership resolver parameter.
6. **Update ACL propagation**: Resolve teams to members.
7. **Update share dialog**: Add team search + team ACL entries.
8. **Add team management UI**: In admin panel or space app. Use better-auth client APIs.
9. **Add `org-read`/`org-write` visibility**: Extend `DriveVisibility` type + ACL checks.

**Files touched**:
- `apps/api/src/lib/auth/auth.ts` — enable teams
- `apps/api/auth-schema.ts` — add team/teamMember tables
- `packages/lib/src/types/drive.ts` — extend `DriveACL`, `DriveVisibility`
- `apps/api/src/lib/drive/acl.ts` — membership resolver in `canRead`/`canWrite`
- `apps/api/src/lib/drive/acl-propagation.ts` — resolve teams
- `apps/api/src/routes/drive.ts` — update ACL validation
- `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` — team sharing UI
- `apps/admin/` — team management pages
- `apps/api/src/routes/setup.ts` — create default org on setup

### Phase 2: Organization-Owned Drives (Large effort)

**Goal**: Shared drives that aren't tied to any individual.

1. **Create `OrgHome` class**: Manages org-level drives.
2. **Create org data directory**: `data/org/{orgId}/drives/`.
3. **Add org drive routes**: `/drive/org/{orgId}/{driveId}/...`.
4. **Drive app UI**: "Shared Drives" section alongside "My Drive" and "Shared with me".
5. **Org drive ACL**: Members with roles (Manager = owner, Editor = write, Viewer = read).

### Phase 3: Guest Access + Public URLs (Medium effort)

See `docs/TODO-GUEST-USERS.md`. Additionally:

1. **Public file routes**: `/p/drive/...` for `public-read`/`public-write` paths.
2. **Public doc viewer**: Read-only Slate renderer for public docs.
3. **Anonymous collab**: Optional — anonymous cursors for `public-write` docs.

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
- Her data in org-owned drives is unaffected (not tied to her)

### Nested teams
**Problem**: Can teams contain other teams?
**Answer**: better-auth teams are flat (within an organization). No nesting. This keeps ACL resolution simple — one lookup, no recursion. If nested groups are needed later, implement as a custom layer on top.

### Team ACL + individual ACL on same path
**Problem**: Bob has read-only via Team "Design", but Alice gives Bob explicit write access on the same folder.
**Answer**: Purely additive, same as current model. `canWrite` checks individual ACL first (finds `write: true` for Bob) → returns `true`. Team ACL doesn't reduce it. Bob has write access.

### Sharing with team you're not a member of
**Problem**: Can Alice share her folder with Team "Sales" even though she's not in Sales?
**Answer**: Yes. Alice has write access to her own folder (owner). The ACL just records `{type: 'team', email: salesTeamId, read: true}`. Alice doesn't need to be in Sales to share with them. Same as how you can share with any email today.

### Org-read visibility on deeply nested file
**Problem**: Folder A is `private`. Subfolder B is `org-read`. Can org members see B?
**Answer**: Yes. `canRead` checks B's visibility first → `org-read` → checks org membership → grants read. The parent's `private` visibility doesn't block it because visibility is checked per-path (not inherited). This is consistent with how `public-read` already works.

### Guest user + team-shared path
**Problem**: A path is shared with Team "Engineering". A guest user (external email, not in any org) tries to access it.
**Answer**: Guest has no team memberships. Team ACL check fails. Individual ACL check fails (guest email not in ACL). Parent check runs. If no ancestor grants access, denied. Correct behavior — guests only access paths where their email is explicitly listed.

### Multiple organizations (future)
**Problem**: User belongs to Org A and Org B. Folder is `org-read` on Org A's drive.
**Answer**: The `org-read` check verifies the user is a member of the **path owner's** organization. If the path's `ownerId` is `orgA`, we check membership in Org A. Cross-org access is only via explicit ACL entries.

---

## Summary

| Feature | Mechanism | Phase |
|---------|-----------|-------|
| Organizations | better-auth `organization()` plugin (already registered) | 1 |
| Teams/Groups | better-auth `teams` feature | 1 |
| Share with team | `DriveACL.type = 'team'` | 1 |
| Org-wide visibility | `DriveVisibility = 'org-read' \| 'org-write'` | 1 |
| Org-owned drives | `OrgHome` class + `data/org/` directory | 2 |
| Guest access | OTP auth + `GuestHome` (see `TODO-GUEST-USERS.md`) | 3 |
| Public URLs | `/p/drive/...` routes, no auth | 3 |

The design is **additive** — no existing behavior changes. Personal data stays per-user. The organization layer adds team-based sharing and org-level visibility on top. better-auth handles all the identity plumbing (membership, invitations, roles). Eigen only needs to extend ACL resolution and add UI for team management.
