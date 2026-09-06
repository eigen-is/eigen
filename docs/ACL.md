# ACL System

> **TLDR**: Additive ACL inheritance down the folder tree — no deny, no org-level entries; IDs are user emails or
> `team_` group IDs. The ACL route takes a **delta** (`{add, remove}`) merged server-side, so concurrent sharers
> can't revert each other. Share propagation to recipient DBs is push-based and **asynchronous** — enforcement
> stays owner-side. Per-path `sharingRestricted` locks access management to the owner.
> Core logic: `apps/api/src/lib/drive/acl.ts`.

## Types

```typescript
type DriveACL = { id: string; read: boolean; write: boolean }  // id = email or team_{id}
type DriveVisibility = 'private' | 'public-read' | 'public-write'
```

Defined in `packages/lib/src/types/drive.ts`.

## Core Logic

**File**: `apps/api/src/lib/drive/acl.ts`

### canReadFromAncestors(ancestors, user, memberships)

Walks a pre-fetched breadcrumb (root-first) and returns `true` on the first ancestor that grants access:

1. Owner → true
2. Team member (path owned by user's team) → true
3. Visibility `public-read` or `public-write` → true
4. User in local `acl` with `read: true` (by email or team membership) → true
5. Default → false

The `Drive.canRead(mountId, pathId, user, memberships?)` method fetches the breadcrumb and delegates to this function.

### canWriteFromAncestors — same pattern, checks `write` and `public-write`

### matchesACL(acl, user, memberships, permission)

Iterates ACL entries for the given permission. Uses `parseOwnerId(entry.id)`: user type matches email (case-insensitive),
team type checks `memberships.teamIds`.

### normalizeACL(acl)

Lowercases email-type ACL entry IDs (leaves team IDs unchanged). Returns `null` for empty arrays. Called by
`Drive.updateACL()` before saving.

### filterRedundantACL

Strips entries already granted by ancestors or by ownership.

## Key Rules

- **Purely additive**: Read-only on child does NOT downgrade inherited write from parent
- **No deny**: No `{read: false}` mechanism
- **External emails**: Any valid email can be in ACLs
- **Team ACL**: Additive with user ACL
- **No org-level ACL**: `parseOwnerId` recognises the `org_` prefix but `matchesACL` only checks `user` and `team`
  entries. Org-wide sharing is not implemented; use teams instead

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

| Column             | Type | Description                                     |
|--------------------|------|-------------------------------------------------|
| `fromUserId`       | TEXT | Resource owner (Home that owns the file/calendar) |
| `targetIdentifier` | TEXT | Email or `team_{id}`                            |

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

On new user, `reconcileSharesForNewUser()` runs:

1. `pullCalendarShares()` — shared calendar entries (synchronous)
2. `pullDriveShares()` — shared drive paths (async, queries drive DB)
3. `pullPendingInvitations()` — calendar invites (synchronous, creates linked event copies)

On new team member, `reconcileSharesForNewTeamMember()` runs steps 1 and 2 only (no pending invitations).
Team registry entries are kept (not deleted) so future members also receive shares.

On user deletion (`deleteUserCompletely`), share registry entries are cleaned up:

- Entries FROM the deleted user (shares they created)
- Entries TO the deleted user's email (shares targeting them)

When ACLs change, `apps/api/src/lib/drive/acl-propagation.ts` updates each affected user's `shared.db`.

### Share Emails

`emailNewlyAddedAclEntries` (`apps/api/src/lib/drive/acl-propagation.ts`) mails every email address newly added to
an ACL. The gate is per recipient: `notifications.email.guestOnAclAdd` when the address has no account or belongs
to a guest, `notifications.email.userOnAclAdd` when it is a registered user. Callers that send their own invite
pass `suppressShareEmail`, which only suppresses mail to registered users — an account-less address still gets the
invite, because that mail is the only way in. Both settings live in [SERVER-SETTINGS.md](SERVER-SETTINGS.md).

### Pull Routes

```
GET /calendar/:ownerId/shared-with-me
GET /drive/:ownerId/shared-with-me
```

Fan-out only happens on share/unshare (rare). Event data stays in owner's Home — recipients pull on demand. 100
inserts complete in milliseconds with Bun + SQLite. Non-issue for typical deployments.

## Chat Invite Bubbling

Inviting someone to an embedded chat (one living inside an eigendoc/stickies/slides/sheets) sets ACL on the
**container document**, not on the chat. A dedicated endpoint resolves the container server-side and merges the
entry there:

```
POST /chat/:ownerId/:mountId/:chatId/invite
Body: { email: string }
Returns: { alreadyHasAccess: boolean, targetPathId: string }
```

Route in `apps/api/src/routes/chat.ts`, delegating to `drive.inviteToChat(mountId, chatId, email, user)` — the
actor is passed through so propagation can attribute the share and send the invite mail.

### Why Not Set ACL on the Chat Directly

An embedded chat usually has no ACL of its own; it inherits from the container. Granting access on the chat would
put the entry on the wrong path, and a client cannot reliably see (or safely rewrite) the container's ACL. Resolving
the container server-side puts the entry where inheritance actually reads it. This is the same failure class the
delta [ACL route](#acl-route) fixes for the generic path.

### findContainerFromAncestors()

In `apps/api/src/lib/drive/acl.ts`. Walks a pre-fetched breadcrumb (root-first) and returns the **outermost**
`DrivePath` whose type passes `isCollabType()` (doc, stickies, slides, sheets), or `null` for a standalone chat.
`Drive.findContainerPath()` fetches the breadcrumb and delegates. Used by `Drive.inviteToChat()` and
`SharedDrive.inviteToChat()`.

### Rules

- Standalone chat → ACL lands on the chat itself; embedded or nested → on the outermost container
- Target already in the effective ACL → `alreadyHasAccess: true`, no ACL write
- `SharedDrive.inviteToChat()` requires write on the chat **and** on the container — otherwise 403
- `sharingRestricted` on the container blocks editors; the owner (or a team member on a team path) passes
- Emails are lowercased before comparison and storage; invalid email → 400; self-invite is allowed

### Frontend

The `/invite` slash command calls `useInviteToChat()` (`packages/lib/src/core/chat/hooks/use-chat.ts`), which posts
to the endpoint and invalidates `driveKeys.path()` on success. Command handling lives in `use-chat-room.ts`.

## Re-Share Prevention

Per-path `sharingRestricted` flag: only the owner — or a team member on a team-owned path — may change ACL or
visibility. Editors keep full read/write on content. Default `false`, matching pre-flag behaviour.

The ACL model treats "can edit content" and "can manage access" as one permission. Without the flag, sharing a
document with a contractor hands them full sharing power: add anyone, change permissions, flip to public, remove
people. The flag separates the two without adding a third permission level.

**Schema**: `sharingRestricted INTEGER NOT NULL DEFAULT 0` on `paths` (`apps/api/src/lib/mount/schema.ts`) and on
`shared_paths` (`apps/api/src/lib/drive/sharedschema.ts`); `sharingRestricted: boolean` on `DrivePath`.

**Enforcement**: `SharedDrive.updateACLDelta()` checks write permission first, so viewers get the generic "no write
permission" 403 and never learn a restriction exists. Then `isEffectiveOwnerSync()` (owner, or team member on a
team path) decides: a restricted non-owner gets 403, and their `sharingRestricted` value is silently dropped rather
than applied. Chat `/invite` runs the same check. The owner's own `Drive.updateACLDelta()` is unaffected — it runs
as the Home's synthetic user. `receiveSharedPathChange()` mirrors the flag into `shared_paths`, so recipients see
the current restriction state.

### ACL Route

`PUT /drive/:ownerId/:mountId/path/:pathId/acl` takes a **delta**, not a full array:

```typescript
{ add?: DriveACL[]; remove?: string[]; visibility?: DriveVisibility; sharingRestricted?: boolean }
```

The server merges onto the path's current ACL (`mergeACLDelta` in `acl.ts`): removals first
(case-insensitive id match), then upserts — re-adding an existing id replaces its entry, which is how
permission changes travel. `Drive.updateACLDelta` serializes the read-merge-write per path, then delegates
to the internal full-replace `Drive.updateACL` for validation, persistence, and propagation. Full-array
replace is deliberately not accepted from clients: a dialog built from a stale cache would silently revert
entries a concurrent sharer just added (the same failure class chat-invite bubbling fixed). The FE share
dialog (`DriveAccessListEdit`) diffs its edited list against the initial one and sends only the delta.
Defined in `apps/api/src/routes/drive.ts`.

Leaving a share is a delete: `SharedDrive.deletePath` checks whether the path's own ACL names the caller and, if so, removes only that entry through the delta route's merge (no write check — a read-only recipient can always leave, restricted or not), so the owner's file and every other recipient are untouched. Paths reached through a shared folder or a team drive trash the owner's copy as before. The FE mirrors the same test with `useIsSharedWithMe()` so `DriveDeleteItem` can confirm and say "Remove shared item" instead of "Move to trash".

### Frontend

`useIsEffectiveOwner()` (`packages/lib/src/core/drive/hooks/use-drive-access.ts`) decides what the share dialog
renders: a restricted non-owner gets the read-only `DriveAccessList`, everyone else `DriveAccessListEdit` with its
"Editors can share" checkbox (checked = not restricted). The flag is only included in the save payload for effective
owners. Both components sit in `packages/ui/src/components/drive/`.

### Design Decisions

**No inheritance.** Per-path, not inherited from parent folders. A subfolder inside a restricted folder is not
restricted. Matches Google Drive.

**Self-removal is a delete, not an ACL edit.** A restricted editor cannot touch the ACL at all; the only thing they
can do is leave, and that rides on `deletePath` so the ACL route keeps one rule.

**Visibility blocked too.** An editor cannot flip a restricted file to `public-read` — same route, same check.

**Team members are co-owners.** No team user logs in, so team members always arrive through `SharedDrive`.
`isEffectiveOwnerSync()` uses `parseOwnerId()` plus pre-fetched `memberships.teamIds` to grant them full ACL control
on team paths, including toggling the flag itself.

Integration tests: `apps/api/src/test/acl/acl-bubbling.test.ts`, `apps/api/src/test/acl/sharing-restricted.test.ts`.

See: [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for team ACL details, [CHAT.md](CHAT.md) for the chat
system, [SERVER-SETTINGS.md](SERVER-SETTINGS.md) for the email-notification settings
