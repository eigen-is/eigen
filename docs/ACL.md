# ACL System — Architecture & Design

## Overview

Eigen uses a **purely additive ACL inheritance model** (Google Drive approach). Permissions only flow down the folder tree. You can only grant more access on child items, never revoke inherited access.

## Types

```typescript
type DriveACL = {
    email: string
    read: boolean
    write: boolean
    type?: 'user' | 'team'   // default: 'user'
    targetId?: string          // team ID when type is 'team'
}

type DriveVisibility = 'private' | 'public-read' | 'public-write'

type DrivePath = {
    // ... other fields
    acl: DriveACL[] | null
    visibility: DriveVisibility
}
```

- **`acl`** — access control entries. User entries use `email` for matching. Team entries use `type: 'team'` with `targetId` set to the team ID — all team members get access.
- **`visibility`** — link-level access, independent of user ACLs. Lives on `DrivePath` itself.

## Core Logic (`apps/api/src/lib/drive/acl.ts`)

### `canRead(path, user, getPath)`
1. Owner → `true`
2. Team membership → `true` if path is owned by a team the user belongs to
3. `visibility` is `public-read` or `public-write` → `true`
4. User found in local `acl` with `read: true` (email match or team membership) → `true`
5. **Always check parent** (even if local ACL exists but user isn't in it) → recurse
6. Default → `false`

### `canWrite(path, user, getPath)`
Same pattern, but checks `write` and only `public-write` visibility.

### `matchesACL(entry, user)`
Resolves an ACL entry against a user:
- `type: 'user'` (default) — matches by email
- `type: 'team'` — matches if user is a member of the team (via `targetId`)

### `filterRedundantACL(acl, path, getPath)`
On save, auto-strips ACL entries that are redundant:
- Entry already granted by an ancestor's ACL (same or broader permissions)
- Team ACL on a path already owned by that team (all members have full access)

### Key design decisions
- **Purely additive**: A read-only ACL entry on a child folder does **not** downgrade inherited write from a parent. The system checks local first, then walks up. If write is granted anywhere in the ancestor chain, the user can write.
- **No explicit denies**: There is no `{read: false}` deny mechanism. If a user is in the local ACL with `read: true, write: false`, this does not block inherited write from a parent. The parent check still runs.
- **External emails**: Any valid email address can be added to ACLs (no domain restriction).
- **Team ACL**: Grants access to all members of a team. Combined with user ACL (additive).

## Inheritance Behavior (tested)

### Scenario: Read in Folder A, Write in Folder B (child of A)
```
A (Bob: read)  →  B (Bob: write)  →  C (no ACL)  →  file.txt
```
- Bob can **read** A, but **not write**
- Bob can **read and write** B, C, and file.txt
- Write access from B flows down to all children

### Scenario: Remove Bob from A
- Bob **loses** read access to A
- Bob **keeps** write access to B and everything below (direct ACL on B)

### Scenario: Add read-only on C (child of B)
```
A (Bob: read)  →  B (Bob: write)  →  C (Bob: read-only)
```
- Bob can still **write** to C — the read-only entry does not override the inherited write from B. The system checks C's ACL (finds read, not write), then checks parent B (finds write) → grants write.

### Scenario: Remove Bob from B
- C and file.txt lose write access
- C and file.txt **keep** read access via A's inheritance

## Visibility

`visibility` replaces the old `public` flag on ACL entries:

| Value | Effect |
|-------|--------|
| `private` | Only named users + owner |
| `public-read` | Anyone can read |
| `public-write` | Anyone can read and write |

## Share Dialog UI

The share dialog (`drive-access-list-edit.tsx`) distinguishes between:

- **Direct access** — users/teams explicitly in this path's ACL. Editable (Editor / Viewer / Remove).
- **Inherited access** — users/teams from ancestor ACLs, shown greyed out with source folder name (e.g., "Inherited from 'Project'"). Not editable. User must navigate to the parent folder to change.
- **Team entries** — shown with a group icon instead of user avatar. Team name resolved via API.

The **Share column** in file listings shows avatars for both direct and inherited users via `ancestorAcl` prop.

## ACL Propagation

When ACLs change, `acl-propagation.ts` updates each affected user's `shared.db` (shared-with-me database). This enables the "Shared with me" view.

## Files

| File | Purpose |
|------|---------|
| `packages/lib/src/types/drive.ts` | `DriveACL`, `DriveVisibility`, `DrivePath` types |
| `apps/api/src/lib/drive/acl.ts` | `canRead`, `canWrite`, `matchesACL`, `normalizeACL`, `filterRedundantACL` |
| `apps/api/src/lib/drive/drive.ts` | `updateACL(mountId, pathId, acl, visibility)` |
| `apps/api/src/lib/drive/acl-propagation.ts` | Propagate changes to shared DBs |
| `apps/api/src/routes/drive.ts` | PUT `/drive/:ownerId/:mountId/path/:pathId/acl` |
| `packages/lib/src/lib/drive/hooks/use-drive.ts` | `useUpdateACL` hook |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Share dialog (inherited vs direct) |
| `packages/ui/src/components/layout/drive/drive-share-summary.tsx` | Share column avatars (with ancestor ACL) |

## Known Limitation: N+1 Query Problem

`canRead`/`canWrite` walk up the tree recursively via `getPath`. For deeply nested files this means one DB query per ancestor. Mitigations for the future:
1. **Materialized paths** — store ancestor IDs on each path for batch lookups
2. **Flattened ACLs** — precompute resolved ACLs on write