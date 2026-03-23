# ACL System

> **TLDR**: Additive ACL inheritance — permissions flow down the folder tree. `canRead`/`canWrite` check local ACL,
> then recurse to parents. No deny mechanism. Supports user emails and `team_` prefixed group IDs. Visibility:
> `private`, `public-read`, `public-write`. Push-based share propagation writes to recipient DBs on share; a share
> registry handles targets that don't exist yet. Chat invites bubble ACL to the outermost container document via
> `findContainerPath()`. A per-path `sharingRestricted` flag lets owners lock down who can manage access without
> removing edit rights. Core logic in `apps/api/src/lib/drive/acl.ts`.

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

## Effective Members

`Drive.getEffectiveMembers(mountId, pathId)` resolves all users with effective access to a path by walking the
breadcrumb and collecting ACL entries from all ancestors. Teams are expanded to individual members via
`resolveACLToEmails()`. The owner is always included with full permissions. Deduplicated by email (most permissive
wins). Returns `{email: string, read: boolean, write: boolean}[]`.

```
GET /drive/:ownerId/:mountId/path/:pathId/effective-members
```

Used by:

- `useChatRoom` — resolves room members for embedded chats (where the chat has no direct ACL)
- `ChatRoom.notifySharedUsers()` — determines which users to send SSE events to

## Share Propagation

Push-based sharing for Drive and Calendar. On share: resolve targets, write to recipient's DB. If the target doesn't
exist yet, write to the share registry. On account/team join: pull from registry to reconcile missed shares.

### Model

**Direct push (on share):**

1. Resolve targets (email → user, team → members)
2. For each resolved user: `getHome(userId)` → write to recipient's DB
3. For unresolved targets: write to share registry
4. For team targets: push to current members AND write registry (for future members)

**Pull (on account/team join):**

1. Query share registry for entries targeting the new user/team member
2. For each `fromUserId`: call pull routes to fetch shared resources
3. Write to own DB, delete consumed user entries (keep team entries)

### Share Registry

**Database**: `data/server/eigen.db` (server-level, `ManagedDatabase`)

| Column             | Type | Description            |
|--------------------|------|------------------------|
| `fromUserId`       | TEXT | User who created share |
| `targetIdentifier` | TEXT | Email or `team_{id}`   |

PK: `(fromUserId, targetIdentifier)`. No share data — just the pair. Pull routes handle domain resolution.

**Write rules:**

- User exists → push directly, no registry
- User doesn't exist → write to registry
- Team → push to members + always write to registry
- All shares removed between A and B → delete registry entry

### Reconciliation

**Triggers:**

- **Account created**: `databaseHooks.user.create.after` in `apps/api/src/lib/auth/auth.ts`
- **Team member added**: `organizationHooks.afterAddTeamMember` on the `organization()` plugin in `apps/api/src/lib/auth/auth.ts`

On new user/team member, `reconcileSharesForNewUser()` runs:

1. `pullCalendarShares()` — shared calendar entries (synchronous)
2. `pullDriveShares()` — shared drive paths (async, queries drive DB)
3. `pullPendingInvitations()` — calendar invites (synchronous, creates linked event copies)

On user deletion (`deleteUserCompletely`), share registry entries are cleaned up:

- Entries FROM the deleted user (shares they created)
- Entries TO the deleted user's email (shares targeting them)

When ACLs change, `apps/api/src/lib/drive/acl-propagation.ts` updates each affected user's `shared.db`.

### Pull Routes

```
GET /calendar/:ownerId/shared-with-me
GET /drive/:ownerId/shared-with-me
```

Fan-out only happens on share/unshare (rare). Event data stays in owner's Home — recipients pull on demand. 100
inserts complete in milliseconds with Bun + SQLite. Non-issue for typical deployments.

## Chat Invite Bubbling

When inviting someone to an embedded chat (inside an eigendoc/stickies/slides/sheets), ACL is set on the container
document — not on the chat itself. A dedicated invite endpoint resolves the outermost container via
`findContainerPath()`, merges the new ACL entry server-side, and delegates to `Drive.inviteToChat()`. The generic
`Drive.updateACL()` is not involved.

### Why Not Set ACL on the Chat Directly

The generic `PUT /drive/.../acl` endpoint replaces the entire ACL array. The frontend builds that array from the
current path's ACL. An embedded chat typically has no direct ACL (it inherits from the container), so the built array
would contain only the new entry — overwriting the container's existing ACL entries. Server-side resolution and merging
avoids this data loss.

### findContainerPath()

**File**: `apps/api/src/lib/drive/acl.ts`

Walks the `parentId` chain upward from a starting path. Returns the outermost `DrivePath` whose MIME type is a collab
type (eigendoc, eigenstickies, eigenslides, eigensheets), or `null` if none is found (standalone chat).

```
chat/General.eigenchat  → not collab
my-doc.eigendoc         → IS collab → container
Projects/               → folder
root                    → stop
→ returns my-doc.eigendoc
```

Used by `ChatRoom.init()` and `Drive.inviteToChat()`.

### Invite Endpoint

```
POST /chat/:ownerId/:mountId/:chatId/invite
Body: { email: string }
Returns: { alreadyHasAccess: boolean, targetPathId: string }
```

Route in `apps/api/src/routes/chat.ts`. Delegates to `drive.inviteToChat(mountId, chatId, email)`.

### Drive.inviteToChat()

**File**: `apps/api/src/lib/drive/drive.ts`

1. Finds the chat path
2. Calls `findContainerPath()` to locate the outermost container
3. If embedded: sets ACL on the container document
4. If standalone: sets ACL on the chat itself
5. Lowercases the email before adding to ACL
6. Returns `{ alreadyHasAccess, targetPathId }`

### SharedDrive.inviteToChat() Override

**File**: `apps/api/src/lib/drive/sharedDrive.ts`

Adds permission checks before delegating to the underlying drive:

1. Verifies write permission on the chat
2. Finds container via `findContainerPath()`
3. Verifies write permission on the container (if present)
4. Checks `sharingRestricted` flag — blocks non-owners from inviting
5. Delegates to underlying drive

### Frontend

The `/invite` slash command in chat calls `useInviteToChat()`, which posts to the invite endpoint and invalidates
`driveKeys.path()` on success.

**Hook**: `useInviteToChat()` in `packages/lib/src/core/chat/hooks/use-chat.ts`
**Command handler**: `use-chat-room.ts` — the `/invite` case calls `inviteToChat.mutateAsync({ email })`

### Edge Cases

| Case                              | Behavior                                                  |
|-----------------------------------|-----------------------------------------------------------|
| Standalone chat                   | `findContainerPath()` returns `null` → ACL on chat itself |
| Embedded chat                     | ACL on outermost container document                       |
| Nested (chat in folder in doc)    | ACL on outermost container                                |
| Already has access                | Returns `alreadyHasAccess: true`, no ACL change           |
| Chat write but no container write | 403                                                       |
| `sharingRestricted` on container  | Blocks editors, owner bypasses                            |
| Invalid email                     | 400                                                       |
| No write permission               | 403                                                       |
| Case-insensitive emails           | Email lowercased before comparison and storage            |
| Self-invite                       | Allowed                                                   |

## Re-Share Prevention

Per-path `sharingRestricted` flag that limits ACL and visibility changes to the owner (or team members for team
drives). Editors keep full read/write access to content but cannot add/remove people or change visibility. Default:
`false` (editors can share, matching pre-flag behaviour).

### Why

The ACL model treats "can edit content" and "can manage access" as the same permission. Without this flag, sharing a
document with a contractor gives them full sharing power — they can add anyone, change permissions, flip visibility to
public, or remove people. The `sharingRestricted` flag separates these concerns without adding a third permission
level.

### Schema

Both `paths` (mount DB) and `shared_paths` (drive DB) have the column:

```sql
sharingRestricted INTEGER NOT NULL DEFAULT 0
```

Drizzle schemas: `apps/api/src/lib/mount/schema.ts`, `apps/api/src/lib/drive/sharedschema.ts`.
TypeScript type: `sharingRestricted: boolean` on `DrivePath` in `packages/lib/src/types/drive.ts`.

### Backend Enforcement

**`SharedDrive.updateACL()`** (`apps/api/src/lib/drive/sharedDrive.ts`) checks the flag after verifying write
permission:

1. `withWritePermission()` — non-editors get 403 "no write permission" (viewers never see the restriction error)
2. `isEffectiveOwner()` — returns `true` if the path is team-owned and the caller is a team member
3. If `sharingRestricted && !effectiveOwner` — 403 "Sharing is restricted by the owner"
4. The `sharingRestricted` parameter itself is only passed through to `Drive.updateACL()` when the caller is an
   effective owner; for all other callers it is silently dropped

The owner's own `Drive.updateACL()` is unaffected — it operates on the Home's synthetic user who always passes
ownership checks.

Chat `/invite` goes through `SharedDrive.inviteToChat()`, which applies the same `sharingRestricted` check before
delegating.

### ACL Route

`PUT /drive/:ownerId/:mountId/path/:pathId/acl` accepts an optional `sharingRestricted: boolean` in the body.
Defined in `apps/api/src/routes/drive.ts`.

### Propagation

`receiveACLChange()` in `drive.ts` mirrors `sharingRestricted` to `shared_paths` alongside all other `DrivePath`
fields, so recipients see the current restriction state in their shared-with-me view.

### Frontend

**Share dialog** (`packages/ui/src/components/layout/drive/drive-access-dialog.tsx`):

- `useIsEffectiveOwner()` determines if the caller is the owner or a team member
- When `sharingRestricted && !isEffectiveOwner`, the dialog renders the read-only `DriveAccessList` instead of
  `DriveAccessListEdit`

**Edit view** (`packages/ui/src/components/layout/drive/drive-access-list-edit.tsx`):

- Shows an "Editors can share" checkbox, visible only to effective owners
- Checked (default) = `sharingRestricted: false`; unchecked = `sharingRestricted: true`
- The `sharingRestricted` value is only included in the save payload when the caller is an effective owner

### Design Decisions

**No inheritance.** The flag is per-path, not inherited from parent folders. Creating a subfolder inside a restricted
folder does not restrict it. Matches Google Drive's behaviour.

**No self-removal exception.** When restricted, editors cannot modify the ACL at all — including removing themselves.
To "leave" a share, hide it client-side or ask the owner. A dedicated `DELETE .../acl/me` endpoint can be added later
if needed.

**Visibility blocked too.** The flag blocks both ACL and visibility changes. An editor cannot flip a restricted file to
`public-read`. Both go through the same `updateACL` route and the same check.

**Team members are co-owners.** Team members always go through `SharedDrive` (no team user logs in).
`isEffectiveOwner()` uses `parseOwnerId()` + `getMemberships()` to grant team members full ACL control on team paths,
including toggling the flag itself.

## Files

| File                                                                 | Purpose                                                                 |
|----------------------------------------------------------------------|-------------------------------------------------------------------------|
| `packages/lib/src/types/drive.ts`                                    | `DriveACL`, `DriveVisibility`, `sharingRestricted` on `DrivePath`       |
| `apps/api/src/lib/drive/acl.ts`                                      | `canRead`, `canWrite`, `matchesACL`, `filterRedundantACL`, `findContainerPath()` |
| `apps/api/src/lib/drive/acl-propagation.ts`                          | Drive-specific propagation + registry, `resolveACLToEmails()`, `EffectiveMember` |
| `apps/api/src/lib/drive/drive.ts`                                    | `getEffectiveMembers()`, `inviteToChat()`, `updateACL()`, `receiveACLChange()` |
| `apps/api/src/lib/drive/sharedDrive.ts`                              | Permission checks, `isEffectiveOwner()`, `inviteToChat()`/`updateACL()` overrides |
| `apps/api/src/lib/mount/schema.ts`                                   | `sharingRestricted` column on `paths` table                             |
| `apps/api/src/lib/drive/sharedschema.ts`                             | `sharingRestricted` column on `shared_paths` table                      |
| `apps/api/src/lib/share/schema.ts`                                   | Share registry Drizzle schema                                           |
| `apps/api/src/lib/share/db-config.ts`                                | Registry DatabaseConfig + migration                                     |
| `apps/api/src/lib/share/db.ts`                                       | `getEigenDb()` server-level DB singleton                                |
| `apps/api/src/lib/share/registry.ts`                                 | Registry CRUD operations                                                |
| `apps/api/src/lib/share/reconciliation.ts`                           | Pull logic for new users/team members                                   |
| `apps/api/src/lib/calendar/share-propagation.ts`                     | Calendar-specific propagation + registry                                |
| `apps/api/src/routes/drive.ts`                                       | ACL route with optional `sharingRestricted`                             |
| `apps/api/src/routes/chat.ts`                                        | `POST /chat/:ownerId/:mountId/:chatId/invite` route                     |
| `packages/lib/src/core/drive/hooks/use-drive.ts`                     | `useEffectiveMembers()` hook                                            |
| `packages/lib/src/core/chat/hooks/use-chat.ts`                       | `useInviteToChat()` mutation hook                                       |
| `packages/lib/src/core/chat/hooks/use-chat-room.ts`                  | `/invite` command handler                                               |
| `packages/ui/src/components/layout/drive/drive-access-dialog.tsx`    | Share dialog, read-only fallback when restricted                        |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Share dialog edit view, "Editors can share" checkbox                    |
| `apps/api/src/tests/acl-bubbling.test.ts`                            | ACL bubbling integration tests                                          |
| `apps/api/src/test/sharing-restricted.test.ts`                       | Sharing restriction integration tests                                   |

See: [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for team ACL details, [CHAT.md](CHAT.md) for the chat system
