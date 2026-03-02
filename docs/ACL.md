# ACL System — Architecture & Design

Eigen uses an **additive ACL inheritance model**. Permissions flow down the folder tree. You can only grant more access
on child items, never revoke inherited access.

## Types

```typescript
export type DriveACL = {
    id: string;      // User email or team_ID / org_ID
    read: boolean;
    write: boolean;
}

export type DriveVisibility = 'private' | 'public-read' | 'public-write';

export type DrivePath = {
    // ... other fields
    acl: DriveACL[] | null
    visibility: DriveVisibility
}
```

- **`acl`**: Access control entries. The `id` field stores either the user's email address or a prefixed group ID (like
  `team_xyz`).
- **`visibility`**: Link-level access, independent of user ACLs.

## Core Logic (`apps/api/src/lib/drive/acl.ts`)

### `canRead(path, user, getPath)`
1. Owner → `true`
2. Team membership → `true` if path is owned by a team the user belongs to
3. `visibility` is `public-read` or `public-write` → `true`
4. User found in local `acl` with `read: true` (matching email or team membership) → `true`
5. **Always check parent** (recurse) → `true` if any ancestor grants access
6. Default → `false`

### `canWrite(path, user, getPath)`

Follows the same pattern as `canRead`, checking `write` and `public-write`.

### `matchesACL(entry, user)`

Resolves an ACL entry against a user using `parseOwnerId(entry.id)`:

- Type `user`: Matches if entry ID matches user's email.
- Type `team`/`org`: Matches if user is a member of the group.

### `filterRedundantACL(acl, path, getPath)`

Auto-strips ACL entries that are redundant on save:
- Entry already granted by an ancestor's ACL (same or broader permissions)
- Group ACL on a path already owned by that group

### Key Design Decisions

- **Purely additive**: A read-only ACL entry on a child folder does **not** downgrade inherited write access from a
  parent.
- **No explicit denies**: There is no `{read: false}` deny mechanism.
- **External emails**: Any valid email address can be added to ACLs.
- **Group ACL**: Combined with user ACL (additive).

## Inheritance Behavior

### Scenario: Read in A, Write in B (child of A)
```
A (Bob: read)  →  B (Bob: write)  →  C (no ACL)  →  file.txt
```

- Bob can **read** A, but **not write**.
- Bob can **read and write** B, C, and file.txt.

### Scenario: Remove Bob from A

- Bob **loses** read access to A.
- Bob **keeps** write access to B and everything below (direct ACL on B).

### Scenario: Add read-only on C (child of B)
```
A (Bob: read)  →  B (Bob: write)  →  C (Bob: read-only)
```

- Bob can still **write** to C. The read-only entry does not override the inherited write from B.

## Visibility

`visibility` replaces the old `public` flag:

| Value | Effect |
|-------|--------|
| `private` | Only named users + owner |
| `public-read` | Anyone can read |
| `public-write` | Anyone can read and write |

## Share Dialog UI

The share dialog (`drive-access-list-edit.tsx`) distinguishes between:

- **Direct access**: Users/teams explicitly in this path's ACL. Editable.
- **Inherited access**: Users/teams from ancestor ACLs. Shown greyed out. Not editable here.
- **Team entries**: Shown natively via `UserPublicItem` handling.

The **Share column** in file listings shows avatars for both direct and inherited users.

## ACL Propagation

When ACLs change, `acl-propagation.ts` updates each affected user's `shared.db` (shared-with-me database).

## Files

| File                                                                 | Purpose                                                                   |
|----------------------------------------------------------------------|---------------------------------------------------------------------------|
| `packages/lib/src/types/drive.ts`                                    | `DriveACL`, `DriveVisibility`, `DrivePath` types                          |
| `apps/api/src/lib/drive/acl.ts`                                      | `canRead`, `canWrite`, `matchesACL`, `normalizeACL`, `filterRedundantACL` |
| `apps/api/src/lib/drive/drive.ts`                                    | `updateACL()`                                                             |
| `apps/api/src/lib/drive/acl-propagation.ts`                          | Propagate changes to shared DBs                                           |
| `apps/api/src/routes/drive.ts`                                       | PUT `/drive/:ownerId/:mountId/path/:pathId/acl`                           |
| `packages/lib/src/lib/drive/hooks/use-drive.ts`                      | `useUpdateACL` hook                                                       |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Share dialog UI                                                           |
| `packages/ui/src/components/layout/drive/drive-share-summary.tsx`    | Share column UI                                                           |