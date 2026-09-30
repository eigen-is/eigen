# ACL System

> **TLDR**: ACL inheritance down the folder tree is additive: no deny, no org-level entries. IDs are user emails or `team_` group IDs. The ACL route takes a **delta** (`{add, remove}`) merged server-side, so concurrent sharers can't revert each other. Share propagation to recipient DBs is push-based and **asynchronous**, and enforcement stays owner-side. Per-path `sharingRestricted` locks access management to the owner. Core logic: `apps/api/src/lib/drive/acl.ts`.

## Types

```typescript
type DriveACL = { id: string; read: boolean; write: boolean }  // id = email or team_{id}
type DriveVisibility = 'private' | 'public-read' | 'public-write'
```

Defined in `packages/lib/src/types/drive.ts`.

## Core Logic

**File**: `apps/api/src/lib/drive/acl.ts`

### canReadFromAncestors(ancestors, user, memberships)

Walks a pre-fetched breadcrumb (root-first, ending at the path itself) and returns `true` on the first ancestor that grants access:

1. Owner → true
2. Team member (path owned by user's team) → true
3. Visibility `public-read` or `public-write` → true
4. User in local `acl` with `read: true` (by email or team membership) → true
5. Default → false

The `Drive.canRead(mountId, pathId, user, memberships?)` method fetches the breadcrumb and delegates to this function.

### canWriteFromAncestors

The same walk, checking `write` and `public-write`.

### matchesACL(acl, user, memberships, permission)

Iterates ACL entries for the given permission. Uses `parseOwnerId(entry.id)`: user type matches email (case-insensitive), team type checks `memberships.teamIds`. No other entry type ever matches.

### normalizeACL(acl)

Lowercases email ACL entry IDs through `canonicalACLId`. Team IDs and every other form stay as they are, because lowercasing them would resolve to nothing. Returns `null` for empty arrays. Called by `Drive.updateACL()` before saving.

### filterRedundantACL

Strips entries an ancestor's ACL already grants to the same id, and a team entry on a path that same team owns.

## Key Rules

- **Purely additive**: Read-only on child does NOT downgrade inherited write from parent
- **No deny**: No `{read: false}` mechanism
- **External emails**: Any valid email can be in ACLs
- **Team ACL**: Additive with user ACL
- **No org-level ACL**: `parseOwnerId` recognizes the `org_` prefix but `matchesACL` only checks `user` and `team` entries. Org-wide sharing is not implemented; use teams instead
- **The root folder has no ACL**: `Drive.updateACL` refuses a mount's root with 403

## Visibility

| Value          | Effect                    |
|----------------|---------------------------|
| `private`      | Only named users + owner  |
| `public-read`  | Anyone can read           |
| `public-write` | Anyone can read and write |

## Effective Members

`Drive.getEffectiveMembers(mountId, pathId)` resolves all users with effective access to a path by walking the breadcrumb and collecting ACL entries from all ancestors. Teams are expanded to individual members via `resolveACLToEmails()`. The owner is always included with full permissions, and on a team drive so is every team member. Deduplicated by email (most permissive wins). Returns `{email: string, read: boolean, write: boolean}[]`. It does not count public visibility.

```
GET /drive/:ownerId/:mountId/path/:pathId/effective-members
```

Used by:

- `useChatRoom`: resolves room members for embedded chats (where the chat has no direct ACL)
- `ChatRoom.notifySharedUsers()`: determines which users to send SSE events to

## Share Propagation

Push-based sharing for Drive and Calendar. On share: resolve targets, write to recipient's DB. If the target doesn't exist yet, write to the share registry. On account/team join: pull from registry to reconcile missed shares.

`Drive.updateACL` awaits the target resolution and its registry writes, because they are the durable record for targets without an account. The pushes to recipient homes are queued (`acl-propagation.ts`): bounded concurrency, in order per path, since an out-of-order add and revoke would resurrect a stale mirror row. A crash loses deliveries still in flight: the "Durable home-relay outbox" row of [ROADMAP.md](ROADMAP.md) closes that, and [SCALABILITY.md](SCALABILITY.md#a-relay-message-in-flight-is-lost-on-a-crash) has the relay side.

A saved ACL change also closes the live collab sockets of anyone who lost read below that path (`enforceReadAccessBelow`), so a revoke takes effect now, not at the next reconnect. How it walks the open documents: [COLLAB.md](COLLAB.md#read-is-checked-at-open-write-on-every-message).

### Model

**Direct push (on share):**

1. Resolve targets (email → user, team → members), from both the old and the new ACL so a removed user hears about it
2. For each resolved user: the [home relay](SCALABILITY.md#every-cross-home-call-goes-through-the-relay) pushes the change into the recipient's `shared.db` (`receiveSharedPathChange`)
3. For unresolved targets: write to share registry
4. For team targets: push to current members AND write registry (for future members)

**Pull (on account/team join):**

1. Query share registry for entries targeting the new user/team member
2. For each `fromUserId`: read the shared resources from that owner's home through the home-relay pull functions
3. Write to own DB. Registry entries are never consumed: they stay for future team members and for a guest who signs in again

### Share Registry

**Database**: `data/server/eigen.db` (server-level, `ManagedDatabase`)

| Column             | Type | Description                                     |
|--------------------|------|-------------------------------------------------|
| `fromUserId`       | TEXT | Resource owner (Home that owns the file/calendar) |
| `targetIdentifier` | TEXT | Email or `team_{id}`                            |

PK: `(fromUserId, targetIdentifier)`. No share data, just the pair. Reconciliation handles domain resolution.

**Write rules:**

- User exists → push directly, no registry
- User doesn't exist → write to registry
- Team → push to members + always write to registry
- A revoke leaves the entry. Reconciliation re-reads the owner's current shares, so a stale entry delivers nothing. What it still admits is in [GUEST-ACCESS.md](GUEST-ACCESS.md#a-revoked-share-leaves-its-registry-entry)

### Reconciliation

**Triggers:**

- **Account created**: `databaseHooks.user.create.after` in `apps/api/src/lib/auth/auth.ts` (not for guests)
- **Guest signs in**: every successful OTP verification ([GUEST-ACCESS.md](GUEST-ACCESS.md))
- **Team member added**: `organizationHooks.afterAddTeamMember` on the `organization()` plugin in `apps/api/src/lib/auth/auth.ts`

On new user, `reconcileSharesForNewUser()` (`apps/api/src/lib/share/reconciliation.ts`) runs, per source:

1. `pullCalendarShares()`: shared calendar entries
2. `pullSharedPaths()`: shared drive paths
3. `pullPendingInvitations()`: calendar invites (creates linked event copies)

A home without a calendar (a guest's) skips steps 1 and 3. On new team member, `reconcileSharesForNewTeamMember()` runs steps 1 and 2 only (no pending invitations) and delivers through `sendToHome`, since it writes another user's home.

A source can be a team: a share on a team drive path records `team_<id>` as `fromUserId`. Reconciliation resolves it through the team (`getTeam`), not as a user id, and delivers drive paths only, attributed to the team name, since a team has no calendars or invitations to pull. Without this, a guest granted a team-owned document gets in but never sees it in *Shared with me*, and neither does a user who joins a granted team later.

User deletion cleans the registry: see [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md#deleting-a-user-runs-one-teardown-from-every-entry-point).

### Share Emails

`propagateSharedPathChange` (`apps/api/src/lib/drive/acl-propagation.ts`) mails every email address newly added to an ACL, when the change has an actor. The gate is per recipient: `notifications.email.guestOnAclAdd` when the address has no account or belongs to a guest, `notifications.email.userOnAclAdd` when it is a registered user. Callers that send their own invite pass `suppressShareEmail`. `'registered'` suppresses mail to registered users only: an account-less address still gets the invite, because that mail is the only way in. `'all'` suppresses both, for a grant whose own message carries the invite link (a mail send). Both settings live in [SERVER-SETTINGS.md](SERVER-SETTINGS.md).

### Pull Routes

Reconciliation reads through the home-relay pull functions. The same reads answer two routes, each returning only the caller's own shares on that owner:

```
GET /calendar/:ownerId/shared-with-me
GET /drive/:ownerId/shared-with-me
```

Fan-out only happens on share/unshare (rare). Event data stays in owner's Home, and recipients pull on demand. Non-issue for typical deployments.

## Chat Invite Bubbling

Inviting someone to an embedded chat (one living inside a doc, stickies, slides, sheets or vector container) sets ACL on the **container document**, not on the chat. A dedicated endpoint resolves the container server-side and merges the entry there:

```
POST /chat/:ownerId/:mountId/:chatId/invite
Body: { email: string }
Returns: { alreadyHasAccess: boolean, targetPathId: string }
```

Route in `apps/api/src/routes/chat.ts`, delegating to `drive.inviteToChat(mountId, chatId, email, user)`. The actor is passed through so propagation can attribute the share and send the invite mail.

### Why Not Set ACL on the Chat Directly

An embedded chat usually has no ACL of its own; it inherits from the container. Granting access on the chat would put the entry on the wrong path, and a client cannot reliably see (or safely rewrite) the container's ACL. Resolving the container server-side puts the entry where inheritance actually reads it. This is the same failure class the delta [ACL route](#acl-route) fixes for the generic path.

### findContainerFromAncestors()

In `apps/api/src/lib/drive/acl.ts`. Walks a pre-fetched breadcrumb (root-first) and returns the **outermost** `DrivePath` whose type passes `isCollabType()` (doc, stickies, slides, sheets, vector), or `null` for a standalone chat. `Drive.findContainerPath()` fetches the breadcrumb and delegates. Used by `Drive.inviteToChat()` and `SharedDrive.inviteToChat()`.

### Rules

- Standalone chat → ACL lands on the chat itself; embedded or nested → on the outermost container
- The invitee gets read and write
- Target already named in the target path's own ACL → `alreadyHasAccess: true`, no ACL write. Access inherited from a folder above does not count
- `SharedDrive.inviteToChat()` requires write on the chat **and** on the container, otherwise 403
- `sharingRestricted` on the container blocks editors; the owner (or a team member on a team path) passes
- Emails are lowercased before comparison and storage; invalid email → 400; self-invite is allowed

### Frontend

The `/invite` slash command calls `useInviteToChat()` (`packages/lib/src/core/chat/hooks/use-chat.ts`), which posts to the endpoint and invalidates `driveKeys.path()` on success. Command handling lives in `use-chat-room.ts`.

## Re-Share Prevention

Per-path `sharingRestricted` flag: only the owner, or a team member on a team-owned path, may change ACL or visibility. Editors keep full read/write on content. Default `false`.

The ACL model treats "can edit content" and "can manage access" as one permission. Without the flag, sharing a document with a contractor hands them full sharing power: add anyone, change permissions, flip to public, remove people. The flag separates the two without adding a third permission level.

**Schema**: `sharingRestricted INTEGER NOT NULL DEFAULT 0` on `paths` (`apps/api/src/lib/mount/schema.ts`) and on `shared_paths` (`apps/api/src/lib/drive/sharedschema.ts`); `sharingRestricted: boolean` on `DrivePath`.

**Enforcement**: `SharedDrive.updateACLDelta()` checks write permission first, so viewers get the generic "no write permission" 403 and never learn a restriction exists. Then `isEffectiveOwnerSync()` (a team member on a team path) decides: a restricted non-owner gets 403, and a non-owner's `sharingRestricted` value is silently dropped rather than applied. Chat `/invite` and the mail `access-check` (`canShare`) run the same check. The owner is unaffected: `getSharedDrive` hands the owner their own `Drive`, with no wrapper and no restriction check. `receiveSharedPathChange()` mirrors the flag into `shared_paths`, so recipients see the current restriction state.

### ACL Route

`PUT /drive/:ownerId/:mountId/path/:pathId/acl` takes a **delta**, not a full array:

```typescript
{ add?: DriveACL[]; remove?: string[]; visibility?: DriveVisibility; sharingRestricted?: boolean }
```

The server merges onto the path's current ACL (`mergeACLDelta` in `acl.ts`): removals first (matched on `canonicalACLId`, so emails match case-insensitively), then upserts. Re-adding an existing id replaces its entry, which is how permission changes travel. `Drive.updateACLDelta` serializes the read-merge-write per path, then delegates to the internal full-replace `Drive.updateACL` for validation, persistence, and propagation. Full-array replace is deliberately not accepted from clients: a dialog built from a stale cache would silently revert entries a concurrent sharer just added (the same failure class chat-invite bubbling fixed). The FE share dialog (`DriveAccessListEdit`) diffs its edited list against the initial one and sends only the delta. Defined in `apps/api/src/routes/drive.ts`. Each `add[].id` is bounded by `MAX_EMAIL_LENGTH` at the schema (an id is an email or a `team_` id, the same bound the chat invite route uses); the number of entries is not capped ([ROADMAP](ROADMAP.md) § Cheap wins).

`GET /drive/:ownerId/:mountId/path/:pathId/permissions` answers `{ canRead, canWrite }` for any caller, never 403. A stranger gets `{ false, false }`, which is what the request-access view keys off.

Leaving a share is a delete: `SharedDrive.deletePath` checks whether the path's own ACL names the caller by email (and the caller isn't an effective owner) and, if so, removes only that entry through `Drive.updateACLDelta`. There is no write check: a read-only recipient can always leave, restricted or not. The owner's file and every other recipient are untouched, and the recipient's own home skips the "removed your access" notification for it. Access through a shared folder, a team drive or a team ACL entry is not a direct share: a delete there trashes the owner's copy as before, write-gated. The FE mirrors the same test with `useIsSharedWithMe()` so `DriveDeleteItem` can say "Remove shared item" instead of "Move to trash", and `useDriveLayoutDialogs` confirms every delete in a drive the caller doesn't own (`useIsEffectiveOwnerOf()`).

### Frontend

`useIsEffectiveOwner()` (`packages/lib/src/core/drive/hooks/use-drive-access.ts`) decides what the share dialog renders: a guest, or a restricted non-owner, gets the read-only `DriveAccessList`, everyone else `DriveAccessListEdit`. Only effective owners see its "Editors can share" checkbox (checked = not restricted), and the flag is only included in the save payload for them. Both components sit in `packages/ui/src/components/drive/`.

### Design Decisions

**No inheritance.** Per-path, not inherited from parent folders. A subfolder inside a restricted folder is not restricted. Matches Google Drive.

**Self-removal is a delete, not an ACL edit.** A restricted editor cannot touch the ACL at all; the only thing they can do is leave, and that rides on `deletePath` so the ACL route keeps one rule.

**Visibility blocked too.** An editor cannot flip a restricted file to `public-read`: same route, same check.

**Team members are co-owners.** No team user logs in, so team members always arrive through `SharedDrive`. `isEffectiveOwnerSync()` uses `parseOwnerId()` plus pre-fetched `memberships.teamIds` to grant them full ACL control on team paths, including toggling the flag itself.

Integration tests: `apps/api/src/test/acl/acl-bubbling.test.ts`, `apps/api/src/test/acl/sharing-restricted.test.ts`.

See: [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for team ACL details, [CHAT.md](CHAT.md) for the chat system, [SERVER-SETTINGS.md](SERVER-SETTINGS.md) for the email-notification settings, [SCALABILITY.md](SCALABILITY.md) for the home relay, [GUEST-ACCESS.md](GUEST-ACCESS.md) for guests and the share registry, [COLLAB.md](COLLAB.md) for live collab sockets
