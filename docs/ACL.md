# ACL System

> **TLDR**: Additive ACL inheritance — permissions flow down the folder tree. `canRead`/`canWrite` check local ACL, then
> recurse to parents. No deny mechanism. Supports user emails and `team_` prefixed group IDs. Visibility: `private`,
`public-read`, `public-write`. Core logic in `apps/api/src/lib/drive/acl.ts`.

## Types

```typescript
type DriveACL = { id: string; read: boolean; write: boolean }  // id = email or team_{id}
type DriveVisibility = 'private' | 'public-read' | 'public-write'
```

Defined in `packages/lib/src/types/drive.ts`.

## Core Logic

**File**: `apps/api/src/lib/drive/acl.ts`

### canRead(path, user, getPath)

1. Owner → true
2. Team member (path owned by user's team) → true
3. Visibility `public-read` or `public-write` → true
4. User in local `acl` with `read: true` (by email or team membership) → true
5. **Recurse to parent** → true if any ancestor grants access
6. Default → false

### canWrite — same pattern, checks `write` and `public-write`

### matchesACL(entry, user)

Uses `parseOwnerId(entry.id)`: user type matches email, team/org type checks membership via `getMemberships()`.

### filterRedundantACL

Strips entries already granted by ancestors or by ownership.

## Key Rules

- **Purely additive**: Read-only on child does NOT downgrade inherited write from parent
- **No deny**: No `{read: false}` mechanism
- **External emails**: Any valid email can be in ACLs
- **Team ACL**: Additive with user ACL
- **No org-level ACL**: `parseOwnerId` recognises the `org_` prefix but `matchesACL` only handles `user` and `team`.
  Org-wide sharing is not implemented; use teams instead

## Visibility

| Value          | Effect                    |
|----------------|---------------------------|
| `private`      | Only named users + owner  |
| `public-read`  | Anyone can read           |
| `public-write` | Anyone can read and write |

## ACL Propagation

When ACLs change, `apps/api/src/lib/drive/acl-propagation.ts` updates each affected user's `shared.db`.

## Files

| File                                                                 | Purpose                                                   |
|----------------------------------------------------------------------|-----------------------------------------------------------|
| `packages/lib/src/types/drive.ts`                                    | `DriveACL`, `DriveVisibility` types                       |
| `apps/api/src/lib/drive/acl.ts`                                      | `canRead`, `canWrite`, `matchesACL`, `filterRedundantACL` |
| `apps/api/src/lib/drive/acl-propagation.ts`                          | Propagate to shared DBs                                   |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Share dialog UI                                           |

See: [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for team ACL details
