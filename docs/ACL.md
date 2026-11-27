# ACL System

> **TLDR:** Sharing in Drive works with access lists (ACLs). Any file or folder can carry a list of who may read it and who may write it, and a folder's list also counts for everything inside it. An entry names a user by email or a team by its `team_` id. Every access check runs on the owner's side, against the owner's data. A recipient only gets a pointer in their own database, so the item shows under **Shared with me**. The check is `apps/api/src/lib/drive/acl.ts`, and the push to recipients is `apps/api/src/lib/drive/acl-propagation.ts`.

Everything a user stores lives in their Home, the data folder of one user or one team ([STORAGE.md](STORAGE.md)). Drive keeps files in mounts, and each file or folder is a path: a row in the mount's database. A path's owner always has full access. Everyone else gets in through one of three things: an entry in the path's own ACL, an entry on any folder above it, or the visibility of the path or any folder above it, which can open it to every signed-in user for reading or for writing, or to anyone with its link for reading, with no login at all. A team drive adds one rule: every member of the team counts as an owner.

Access only adds up. A child can grant more than its parent and can never take away what the parent gave. There is no deny entry, and no entry for the whole organization: a team covers that. This keeps the check to one walk over the path's breadcrumb, the chain of folders from the mount's root down to the path itself, stopping at the first one that lets the user in. A user's memberships, the list of teams they are in, decide whether a team entry matches.

When a user opens someone else's file, the route hands them the owner's drive wrapped in `SharedDrive`, which asks "may this user read or write this path" before every operation. The owner gets their own drive with no wrapper. A visitor, someone with no login who opens a public link, is no user at all and gets `LinkDrive`, which serves only the reads a link opens ([§ A public link opens a path to anyone without a login](#a-public-link-opens-a-path-to-anyone-without-a-login)).

The recipient still needs to find what was shared. So when an ACL changes, the owner's side pushes a small record into each recipient's own `shared.db`. This push is called propagation, and it is asynchronous: the save answers before every record has landed. The record never grants anything. A recipient who has no account yet, or a team whose members change, is covered by the share registry: a server-wide list of "this owner shared something with this address". It is read when the account or the membership appears, which is called reconciliation.

Three rules sit on top. A client never sends a whole ACL: the route takes a delta, the entries to add and the ids to remove, and the server merges it, so two people sharing at once can't undo each other ([ACL Route](#acl-route)). An editor by name, someone whose write comes from ownership, a team or an ACL entry, can share onward and move the item, unless the path has `sharingRestricted` set, which keeps both to the owner. Write that comes only from `public-write` edits the content: it never changes who has access, moves the item to another folder or mails the people who have it ([Re-Share Prevention](#re-share-prevention)). And a chat inside a document has no list of its own, so inviting someone to it shares the document ([Chat Invite Bubbling](#chat-invite-bubbling)).

The sections run in this order: the types and the check, the rules, visibility and public links, who has access in effect, propagation and the registry, chat invites, and restricted sharing with the ACL route.

## Types

```typescript
type DriveACL = { id: string; read: boolean; write: boolean }  // id = email or team_{id}
type DriveVisibility = 'private' | 'public-read' | 'public-write' | 'link'
```

Defined in `packages/lib/src/types/drive-access.ts`.

## Core Logic

**Files**: `packages/lib/src/types/drive-access.ts` and `apps/api/src/lib/drive/acl.ts`

Access held by name, from ownership, a team or an ACL entry, is one pure rule in lib, `holdsByName(chain, person, teamIds, permission)` with `aclGrants` beside it, so the API's checks and the browser's Move and Share answer it alike. `acl.ts` builds the rest on it and reads no settings: its caller says whether public links are on.

### canReadFromAncestors(ancestors, user, memberships, publicLinks)

Walks a pre-fetched breadcrumb (root-first, ending at the path itself) and returns `true` on the first ancestor that grants access:

1. Owner → true
2. Team member (path owned by user's team) → true
3. User in a path's `acl` with `read: true` (by email or team membership) → true
4. Visibility `public-read` or `public-write`, or `link` while `publicLinks` is true (`grantsPublicRead`) → true
5. Default → false

Steps 1 to 3 are `holdsByName`. When the path or any folder above it is in the trash, only steps 1 and 2 count, for read and write alike: `holdsByName` skips the ACL of a trashed chain and the visibility check refuses it. So a trashed item is its owner's alone until it is restored ([SOFT-DELETE.md](SOFT-DELETE.md#trash-revokes-every-share-and-restore-re-shares-without-an-email)).

The `Drive.canRead(mountId, pathId, user, memberships?)` method fetches the breadcrumb and delegates to this function.

### canWriteFromAncestors

The same walk, checking `write` and `public-write`.

### aclGrants(acl, person, teamIds, permission)

Iterates ACL entries for the given permission. Uses `parseOwnerId(entry.id)`: user type matches email (case-insensitive), team type checks `teamIds`. No other entry type ever matches.

### readerAccess(chain, user, memberships, publicLinks)

What a signed-in reader may do with a path is one answer: `canRead`, `canWrite`, `live` (who gets the collab socket) and `priority` (the transform queue they wait in). `Drive.readerAccess` and the `SharedDrive` pass-through call it, and `getReaderAccess` (`lib/drive/get-drive.ts`) gives the visitor's answer when there is no user. The permissions route, the collab info route and the transform priority all read this one answer, so they can't disagree.

### normalizeACL(acl)

Lowercases email ACL entry IDs through `canonicalACLId`. Team IDs and every other form stay as they are, because lowercasing them would resolve to nothing. Returns `null` for empty arrays. Called by `Drive.updateACLDelta()` before saving.

### filterRedundantACL

Strips entries an ancestor's ACL already grants to the same id, and a team entry on a path that same team owns.

## Key Rules

- **Purely additive**: Read-only on child does NOT downgrade inherited write from parent
- **No deny**: No `{read: false}` mechanism
- **External emails**: Any valid email can be in ACLs
- **Team ACL**: Additive with user ACL
- **No org-level ACL**: `parseOwnerId` recognizes the `org_` prefix but `aclGrants` only checks `user` and `team` entries. Org-wide sharing is not implemented; use teams instead
- **The root folder has no ACL**: `Drive.updateACLDelta` refuses a mount's root with 403
- **A move needs write on the item, on the folder it leaves and on the folder it lands in** (`SharedDrive.movePath`), as a rename needs write on the folder. Otherwise an editor of one file could pull it out of a folder they can't change, into one where more people see it. The write on the item must be held by name (`requireMove`), because in a folder the mover holds by name the item would be theirs to share, and on an item with `sharingRestricted` only an owner may move it, as only an owner may share it ([Re-Share Prevention](#re-share-prevention)). A WebDAV MOVE that keeps the item's folder is a rename and asks only write on that folder ([WEBDAV.md](WEBDAV.md#move-and-copy-stay-inside-one-mount))

## Visibility

| Value          | Effect                    |
|----------------|---------------------------|
| `private`      | Only named users + owner  |
| `public-read`  | Every signed-in user can read |
| `public-write` | Every signed-in user can read and write |
| `link`         | Anyone with the URL can read, signed in or not, while public links are on |

`public-read` and `public-write` need a session: every route that serves them asks for one, so they never reach a visitor.

## A public link opens a path to anyone without a login

The link is the item's ordinary URL: the path id is a random UUID, so the URL is the secret, and choosing another General access closes it. The design and its accepted risks are in [PROPOSAL_PUBLIC_LINKS.md](proposals/PROPOSAL_PUBLIC_LINKS.md).

**Signed in, `link` reads as `public-read`.** `grantsPublicRead` answers true for it, so `canReadFromAncestors` and `checkAccessForEmails` (`lib/drive/sharing.ts`) need no case of their own, and no write follows from it.

**A raw database is a live reader's alone.** `isRawDatabase(chain)` in `lib/drive/acl.ts` names a container's own database, such as a document's `data.db` and `comments.db` or a comment thread's `data.db` (`isContainerDatabase`), and a document's saved version in its `versions/` folder. Each keeps what the merged state leaves out: the stored update rows hold text an author deleted, a version holds the text as it was, and a thread's rows hold deleted messages. So `canReadFromAncestors` refuses one to a reader who reads it only through its visibility and may not write it, the reader whose `readerAccess` is not `live`. Every check that asks it follows, such as path info, a download, a preview, a breadcrumb and WebDAV. `SharedDrive.getFolderContents` leaves them out of a listing for such a reader, and decides `live` once for the folder. Everything else inside a document stays readable: its `media/`, its `chat/` folder, each thread with its `media/`, and the `versions/` folder itself, so the comments, the threads and their attachments keep working. The server still reads the databases for them, such as the merged state, an export, a preview and the comment index, whose `SharedDrive.withDatabase` asks for read on the document. A reader by name, anyone who may write, the owner and the team are unchanged.

**A reader who is not live copies nothing that holds a raw database.** A copy writes the raw databases under its source, so `SharedDrive.copyPath` and `copyPathOver` walk the source with `isRawDatabase` and answer 403 "Only people with access can copy this document" to such a reader when the source is a raw database or holds one anywhere below it, such as the `data.db` of a document, a comment thread or a standalone chat, or a saved version in a document's `versions/` folder. A plain file still copies, and so does a document's `media/`. Accepted: the client still offers Copy to… for a document to them, and the server's 403 is the answer. Drive's menus don't know whether a reader is live, and the refusal says why. Reopen if link readers keep meeting it.

Accepted: someone who reads a plain file through a link can copy it into their own drive and give the copy a link of its own. Whoever reads a file can download it and upload it again, so refusing the copy would protect nothing. Reopen if a link ever means view without download.

**A visitor is checked by `canReadByLink(chain)`**, a pure function beside `canReadFromAncestors`. It answers the index of the highest path in the breadcrumb with `link`, or null. It refuses a chain in the trash, and it holds an allow-list rather than a deny-list: from the public path down every step is a folder, and the last may be a file or a collab document; past a collab document only its `media/` folder and a file in it. So a folder's link covers everything below it, a private subfolder included, and a chat, a document's databases and any path type added later stay closed. The shape is the visitor's own and narrower than `isRawDatabase`, the rule a signed-in reader who is not live meets: it also keeps a document's `chat/` and `versions/` closed, as a visitor gets no comments. There is no write variant, because no route a visitor reaches writes.

**`LinkDrive` (`apps/api/src/lib/drive/link-drive.ts`) is the third drive a route can hold, beside the owner's `Drive` and `SharedDrive`.** It runs the rule before each read and refuses every path alike, with a 403 or `canRead`'s false, so a visitor can't tell a private path from a missing one. It hands out every path with `acl: null`, starts a breadcrumb at the public path and filters a listing by the rule. So Drive's list draws a visitor no Shared with column, while Owner stays, as the public `/p/users` route names the owner to anyone. A route opts in with the `linkAuth` macro (`routes/auth.ts`) and gets its drive from `getReadDrive`; [ARCHITECTURE.md § Drive Architecture](ARCHITECTURE.md#drive-architecture) has all three. Accepted: while public links are on, an unknown owner or mount answers 404 before the rule runs, so a visitor can tell an owner id that exists from one that doesn't. Owner ids are random better-auth ids and a personal mount is always `default`, so the answer says nothing about any path. Reopen if owner ids become guessable.

Accepted: every signed-in reader gets the access lists of what they can read, with email addresses, in a folder's listing and from the `effective-members` route, also someone who reads only through a link. Only a visitor without a login gets none. The Share dialog shows that list to everyone who can open the item, and [PROPOSAL_ACCOUNT_IDENTITY.md](proposals/PROPOSAL_ACCOUNT_IDENTITY.md) turns its entries into references. Reopen when that work lands.

**The server switch closes every link for everyone.** `sharing.publicLinks` is on by default and never on a demo server: `arePublicLinksEnabled()` in `lib/config/server-settings.ts` ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)). `LinkDrive` refuses every path while it is off, before it opens the owner's Home, so with links off a request with no login opens no Home and an unknown owner answers 403, and `grantsPublicRead` counts `link` only while it is on, so a signed-in non-member or a guest loses the read too. People with an ACL entry, the owner and the team keep theirs. The stored value stays, so turning the switch on opens the same URLs again.

**`Drive.updateACLDelta` is the one place that refuses a new link**: 403 while public links are off, and 400 on anything but a file, a folder or a collab document (`canHaveLink`) or on a path inside a document. A path that already has `link` saves as before, so its people can still be changed, or the link closed, while the switch is off. Who may turn a link on is who may make any sharing change: write by name, and the owner when sharing is restricted ([Re-Share Prevention](#re-share-prevention)).

## Effective Members

`Drive.getEffectiveMembers(mountId, pathId)` resolves all users with effective access to a path by walking the breadcrumb and collecting ACL entries from all ancestors. Teams are expanded to individual members via `resolveACLToEmails()`. The owner is always included with full permissions, and on a team drive so is every team member. Deduplicated by email (most permissive wins). Returns `{email: string, read: boolean, write: boolean}[]`. It does not count public visibility.

```
GET /drive/:ownerId/:mountId/path/:pathId/effective-members
```

Used by:

- `useChatRoom`: resolves room members for embedded chats (where the chat has no direct ACL)
- `broadcastToOwnerAndMembers` (`apps/api/src/lib/drive/sse-events.ts`): a `ChatRoom` hands it the effective members to send its SSE events to

## Share Propagation

Push-based sharing for Drive and Calendar. On share: resolve targets, write to recipient's DB. If the target doesn't exist yet, write to the share registry. On account/team join: pull from registry to reconcile missed shares.

`Drive.updateACLDelta` awaits the target resolution and its registry writes, because they are the durable record for targets without an account. The pushes to recipient homes run after the request (`pushToHomes` in `home-relay.ts`). `propagateSharedPathChange` keeps them in order per path, since an out-of-order add and revoke would bring a removed share back. Only a change to the ACL pushes: a rename, a move, a content write, a trash and a restore send nothing, because the recipient's row only names the path ([§ Shared with me reads each path from its owner](#shared-with-me-reads-each-path-from-its-owner)). Two changes to one path's ACL run in turn in a per-path chain, which comes before every mount lock ([STORAGE.md](STORAGE.md#on-local-a-key-is-a-name-path-so-renames-lock-the-whole-tree)). A trash runs in its item's chain too. A fan-out delivers to one home at a time, and no fan-out waits for another except the one before it on the same path. An open is synchronous, so opening many together costs the same CPU and ends in the same file descriptors, but it stops the event loop for the whole fan-out: in the API image, 500 closed user Homes took about 1.5 s and 9,000 fds either way, with a longest gap of about 1.2 s opened together and about 15 ms one at a time. A delivery that hangs holds only the rest of its own fan-out, and the later changes to its path. Nothing retries a delivery, so a crash loses those still in flight ([SCALABILITY.md](SCALABILITY.md#a-relay-message-in-flight-is-lost-on-a-crash)).

Only a live reader holds a collab socket: someone signed in who reads the document by name or may write it (`readerAccess`'s `live`). The socket re-checks that every 15 s and closes when it is gone, so a revoke reaches an open document within 15 s, not at the next reconnect, and write goes with the next frame: [COLLAB.md](COLLAB.md#live-reading-and-the-session-are-checked-at-open-and-every-15-s-write-on-every-message). Anyone else who reads a document loads its stored state over HTTP and meets a revoke at their next fetch ([COLLAB.md § A reader who is not live](COLLAB.md#a-reader-who-is-not-live-loads-the-stored-state-over-http)).

A change that keeps read but moves write, a writer made a viewer or the reverse, reaches an open document through its info query: every ACL event, `DRIVE_ACL_UPDATED` included, refreshes the `collabKeys` info of every open document in the path's mount (`invalidateAclUpdated`), as a folder's change reaches the documents below it. The editor then follows its new `canWrite` without a reload; Docs' editors in [DOCS.md](DOCS.md#one-factory-builds-the-bodys-editor-every-bands-and-each-storys). A tab that got in through the path's visibility is not an ACL recipient and hears no event. Through "Anyone signed in with the link, can edit" it is live, so a narrowed visibility closes its socket at the next 15 s tick and the tab reloads. Any other such tab has no socket and can't write.

### Model

**Direct push (on share):**

1. Resolve targets (email → user, team → members), from both the old and the new ACL so a removed user hears about it
2. For each resolved user: the [home relay](SCALABILITY.md#every-cross-home-call-goes-through-the-relay) pushes the change into the recipient's `shared.db` (`receiveSharedPathChange`)
3. For unresolved targets: write to share registry
4. For team targets: push to current members AND write registry (for future members)

**Pull (on account/team join):**

1. Query share registry for entries targeting the new user/team member
2. For each `fromUserId`: read the shared resources from that owner's home through the home relay's `getFromHomes`
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
- **Team member added**: `organizationHooks.afterAddTeamMember` on the `organization()` plugin in `apps/api/src/lib/auth/auth.ts`, and the org join itself for the default team, since `addMember` skips that hook ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md#every-new-user-joins-the-default-team))

Each trigger calls `reconcileShares(user, teamId?)` (`apps/api/src/lib/share/reconciliation.ts`), which reads the registry for the user's own address, or for the `team_<id>` they joined when it gets a `teamId`. Per source it asks the owner's home, through the home relay's `getFromHomes`:

1. `'drive:shared-with'`: shared drive paths
2. `'calendar:shared-with'`: shared calendar entries, with the strongest permission the user holds by address or through any of their teams. The newcomer has already joined the default team when their address reconciles, so asking by address alone would store a weaker permission than the team gives.
3. `'calendar:pending-invitations'`: calendar invites (creates linked event copies), without a `teamId` only. An invitation names an address, never a team, and an existing user got theirs when it was sent, so a team join reads none: a read would bring back an invitation the member had removed.

The drive read (`Drive.getAllSharedWith`) includes paths in the trash, because a restore pushes nothing: a newcomer who arrives while a shared path or a folder above it is in the trash gets the row and the notice then, and the path shows in **Shared with me** from the restore on. Every other reader of the owner's shared paths, such as `/shared/by-me` and `Drive.getSharedWith`, leaves trashed paths out.

Every delivery goes through `pushToHomes`, which opens the user's home for that one message, and one that fails is logged while the run goes on with the rest. So a home that goes idle and closes during a slow read reopens for the next delivery, and the run holds no Home of its own. A source that fails or does not open within the relay's deadline is left out of that run, which is accepted: a guest reconciles again at each sign-in, while a full account reconciles its address only once, when it is created. A guest's home has no calendar, so a guest runs neither calendar read: each scans the owner's calendar, and the relay would drop the result.

A source can be a team: a share on a team drive path records `team_<id>` as `fromUserId`. Reconciliation resolves it through the team (`getTeam`), not as a user id, and delivers drive paths only, attributed to the team name. Without this, a guest granted a team-owned document gets in but never sees it in **Shared with me**, and neither does a user who joins a granted team later. A team calendar shared with an address before its account exists never arrives ([ROADMAP.md](ROADMAP.md)).

User deletion cleans the registry: see [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md#deleting-a-user-runs-one-teardown-from-every-entry-point).

### Shared with me reads each path from its owner

A row of `shared_paths` in the recipient's `shared.db` holds only the owner, the mount, the path id and `sharedAt`, the time of the first push. A push whose ACL lets the recipient read adds the row if it is missing, with the bell notice, and one that no longer does deletes it, with the "removed your access" notice. The path's owner, and a member of the team that owns it, never get a row (`receiveSharedPathChange`): they see the path in their own drive or the team drive already, so a team member's ACL entry on a team path adds no second copy. A row from before they joined the team stays until the next push for that path, which deletes it without a notice. A push for a row the home already holds, such as a viewer made an editor, changes nothing and keeps `sharedAt`.

`listSharedWithMe` (`apps/api/src/lib/drive/shared-with-me.ts`) reads the rows and asks every owner at once through `readVisiblePaths` in the same file, the read Recent uses ([STORAGE.md](STORAGE.md#a-load-asks-each-owner-whether-the-user-may-still-see-the-path)). Each owner answers with its paths as they are now, so the list shows the current name, folder, size and thumbnail, oldest share first. The owner's side decides what shows: `Drive.getVisiblePaths` leaves out a path that is deleted, in the trash or inside a document, and one the user may no longer read through its chain of folders. The row grants nothing. The listings of one type (`Drive.getMimeTypeContents`) and the chat finder read the same list, passing the type prefix along so each owner answers only the paths of that type. A load costs one read per distinct owner, and the table has no cap.

So a trash and a restore push nothing and send the recipient no "shared with you" or "removed your access" notice: the row stays, the path leaves the list while it is in the trash and returns after the restore with its `sharedAt`. Open tabs still hear both, because the path's own events reach everyone who can read it, and a folder's events also reach everyone who can read a path below it ([SSE.md](SSE.md#a-drive-event-reaches-everyone-who-can-read-the-path)). Whoever watches the path or a folder above it still gets the trash and restore notices (`notifyWatchers`).

A read never deletes a row. The row of a path deleted for good, or of a deleted user or team, stays and lists nothing: deleting an owner reaches into no other home, and `getFromHomes` skips an owner whose Home answers 404 on opening, which is a gone owner or one being deleted. An owner whose home fails, such as a lookup that fails while it opens, or whose home does not open within the relay's deadline, is logged and left out of that one listing, which still answers 200. A restored owner's paths show again at the next load. The Watched view asks the owners in `listSharedOwnerIds` the same way, and every team of the user. A watch outlives a revoked share, so `Drive.getWatches` leaves out a watched path the user can no longer read, for every caller, the owner's own drive included. The user's own drive is read directly, so a failure there fails the Watched request.

Accepted: a part of a document shared on its own, which only the API can do, does not list.

### An ACL entry naming a deleted person stays

A deletion leaves the entries naming that person on other owners' paths on purpose, so a restored user gets their shares back. The cost is that a new account taking that address inherits those entries for now. It is a known open gap, tracked in the "A new account can take a deleted user's email address" row of [ROADMAP.md](ROADMAP.md).

### Share Emails

`propagateSharedPathChange` (`apps/api/src/lib/drive/acl-propagation.ts`) mails every email address newly added to an ACL, when the change has an actor. The gate is per recipient: `notifications.email.guestOnAclAdd` when the address has no account or belongs to a guest, `notifications.email.userOnAclAdd` when it is a registered user. Callers that send their own invite pass `suppressShareEmail`. `'registered'` suppresses mail to registered users only: an account-less address still gets the invite, because that mail is the only way in. `'all'` suppresses both, for a grant whose own message carries the invite link (a mail send). Both settings live in [SERVER-SETTINGS.md](SERVER-SETTINGS.md).

### Pull Routes

Reconciliation reads through the home relay's `getFromHomes`. One route answers from the same reads, returning only the caller's own calendar shares on that owner:

```
GET /calendar/:ownerId/shared-with-me
```

The fan-out runs only when a share changes, which is rare. The data stays in the owner's Home, and recipients read it on demand, so the cost stays small.

## Chat Invite Bubbling

Inviting someone to an embedded chat (one living inside a doc, stickies, slides, sheets or vector container) sets ACL on the **container document**, not on the chat. A dedicated endpoint resolves the container server-side and merges the entry there:

```
POST /chat/:ownerId/:mountId/:chatId/invite
Body: { email: string }
Returns: { alreadyHasAccess: boolean, targetPathId: string }
```

Route in `apps/api/src/routes/chat.ts`, delegating to `drive.inviteToChat(mountId, chatId, email, user)`. The actor is passed through so propagation can attribute the share and send the invite mail.

### Why Not Set ACL on the Chat Directly

An embedded chat usually has no ACL of its own; it inherits from the container. Granting access on the chat would put the entry on the wrong path, and a client cannot reliably see (or safely rewrite) the container's ACL. Resolving the container server-side puts the entry where inheritance actually reads it. The server adds it as a delta through the same per-path chain the [ACL route](#acl-route) uses, so an invite and a concurrent ACL change both land.

### findContainerFromAncestors()

In `apps/api/src/lib/drive/acl.ts`. Walks a pre-fetched breadcrumb (root-first) and returns the **nearest** `DrivePath` above or at the path whose type passes `isCollabType()` (doc, stickies, slides, sheets, vector), the last such path in the chain (`findLast`), or `null` for a standalone chat. `Drive.findContainerPath()` fetches the breadcrumb and delegates. Used by `Drive.inviteToChat()` and `SharedDrive.inviteToChat()`.

### Rules

- Standalone chat → ACL lands on the chat itself; embedded or nested → on the nearest container above it
- The invitee gets read and write
- Target already named in the target path's own ACL → `alreadyHasAccess: true`, no ACL write. Access inherited from a folder above does not count
- The route refuses a guest (`requireNonGuest`), and `SharedDrive.inviteToChat()` requires write on the chat **and** the right to share the container, or the chat itself when it stands alone (`requireShare`, [Re-Share Prevention](#re-share-prevention)), otherwise 403. So someone who edits the document only through `public-write` can't invite. It hands the container it checked to `Drive.inviteToChat()`, so a move that lands in between can't make the invite share a document nobody checked
- Emails are lowercased before comparison and storage; invalid email → 400; self-invite is allowed

### Frontend

The `/invite` slash command calls `useInviteToChat()` (`packages/lib/src/core/chat/hooks/use-chat.ts`), which posts to the endpoint and invalidates `driveKeys.path()` on success. Command handling lives in `use-chat-room.ts`.

## Re-Share Prevention

Changing who has access, the ACL or the visibility, needs write held by name: ownership, membership of the owning team, or an ACL entry with write on the path or a folder above it (`holdsByName` with `'write'`). Write that comes only from `public-write` lets everyone signed in change the content, and never lets them hand it on: otherwise anyone could add themselves, remove the owner's people or open the item to the internet. Two more actions need the same write by name. A move, since in a folder the mover holds by name the item would be theirs to share. And Email collaborators, since the mail goes to the people who have access, so it is for those who may manage that access. A link-only editor still edits, renames, uploads, copies and trashes.

On top sits the per-path `sharingRestricted` flag: only the owner, or a team member on a team-owned path, may change ACL or visibility, or move the item, since the folder it lands in can open it to more people. Editors keep full read/write on content and may still rename it. Default `false`.

For an editor by name, "can edit content" and "can manage access" are one permission. Without the flag, sharing a document with a contractor hands them full sharing power: add anyone, change permissions, flip to public, remove people. The flag separates the two without adding a third permission level.

**Schema**: `sharingRestricted INTEGER NOT NULL DEFAULT 0` on `paths` (`apps/api/src/lib/mount/schema.ts`); `sharingRestricted: boolean` on `DrivePath`.

**Enforcement**: `SharedDrive.requireWriteByName` is the one check of write by name, over the path's breadcrumb. `requireShare` runs it, so a viewer and a link-only editor get the same 403, "No permission to change sharing". `requireMove` runs it on the item and `emailCollaborators` on the path, with their own 403 messages. The owner's restriction applies to sharing and moving, so a restricted editor by name may still mail its people. In `requireShare` and `requireMove`, `sharingRestrictedFor()` decides with `isEffectiveOwner()` (a team member on a team path): a restricted non-owner gets 403. A WebDAV MOVE that keeps the folder is a rename and passes. `updateACLDelta()` runs it before every ACL change, and a non-owner's `sharingRestricted` value is silently dropped rather than applied. Chat `/invite` runs it on the container, and the drive `access-check` answers `canShare` by the same rule, which a mail send's grants read ([MAIL.md](MAIL.md#a-send-grants-access-only-when-the-sender-says-so)). The owner is unaffected: `getSharedDrive` hands the owner their own `Drive`, with no wrapper and no restriction check. A recipient's **Shared with me** reads the flag from the owner's row, so it shows the current state.

### ACL Route

`PUT /drive/:ownerId/:mountId/path/:pathId/acl` takes a **delta**, not a full array:

```typescript
{ add?: DriveACL[]; remove?: string[]; visibility?: DriveVisibility; sharingRestricted?: boolean }
```

The server merges onto the path's current ACL (`mergeACLDelta` in `acl.ts`): removals first (matched on `canonicalACLId`, so emails match case-insensitively), then upserts. Re-adding an existing id replaces its entry, which is how permission changes travel. `Drive.updateACLDelta` serializes the read-merge-write per path, then validates, saves and propagates the merged ACL. Full-array replace is deliberately not accepted from clients: a dialog built from a stale cache would silently revert entries a concurrent sharer just added. The FE share dialog (`DriveAccessListEdit`) diffs its edited list against the initial one and sends only the delta, and sends `visibility` only when the person picked a general access in that dialog and `sharingRestricted` only when the owner changed **Editors can share** there, so a Save that only adds someone cannot undo a change someone else made to it meanwhile. Defined in `apps/api/src/routes/drive-sharing.ts`. Each `add[].id` is bounded by `MAX_EMAIL_LENGTH` at the schema (an id is an email or a `team_` id, the same bound the chat invite route uses); `add` holds at most `MAX_SEND_RECIPIENTS` (100) entries, the cap the access-check route puts on its email list.

`GET /drive/:ownerId/:mountId/path/:pathId/permissions` answers `{ canRead, canWrite }` for any caller, never 403, a visitor without a login included, from `getReaderAccess` (`lib/drive/get-drive.ts`). A stranger gets `{ false, false }`, which is what the request-access view keys off, and a visitor gets `canWrite: false` with the link rule's read.

Leaving a share is a delete: `SharedDrive.deletePath` checks whether the path's own ACL names the caller by email (and the caller isn't an effective owner) and, if so, removes only that entry through `Drive.updateACLDelta`. There is no write check: a read-only recipient can always leave, restricted or not. The owner's file and every other recipient are untouched, and the recipient's own home skips the "removed your access" notification for it. Access through a shared folder, a team drive or a team ACL entry is not a direct share: a delete there trashes the owner's copy like any delete, write-gated. The FE mirrors the same test with `useIsSharedWithMe()` so `DriveDeleteItem` can say **Remove shared item** instead of **Move to trash**, and the Drive action runner (`useDriveActionRunner`) confirms every delete in a drive the caller doesn't own (`useIsEffectiveOwnerOf()`).

### Frontend

`useWritesByName(ownerId, mountId, folderId)` (`packages/lib/src/core/drive/hooks/use-drive-access.ts`) is the server's write by name on the client. It answers a check for each item in or at that folder: an effective owner, or someone a write entry on the item or a folder above it names by email or team, and in the trash only an effective owner. It reads the folders above from the folder's breadcrumb, and until those load only the item's own entries count. `useCanShare(path)` builds on it and decides what the share dialog renders: write by name, unless sharing is restricted for a non-owner, gets `DriveAccessListEdit`. Everyone else gets the read-only `DriveAccessList`: a guest, a viewer, a link-only editor, a restricted non-owner, and anyone, the owner included, on an item in the trash, whose access stays as it is until the restore. Only effective owners see the dialog's **Editors can share** checkbox (checked = not restricted), and a save sends the flag only when they changed it. Both components sit in `packages/ui/src/components/drive/`.

Drive's folder browser and a document's File menu pass that check to `browseCapabilities(canWrite, writesByName)` ([LAYOUT.md](LAYOUT.md#one-drivecapabilities-value-gates-every-drive-action)), and **Move to…**, **Share** and **Email collaborators** ask it of each item. So a link-only editor is offered none of the three, while an item whose own ACL names them, inside a folder they edit only through the link, is offered all three, as the server allows. **Move to…** also asks the item's own `sharingRestricted` against `useIsEffectiveOwnerOf`, which needs no chain, so every view that offers it, a flat one included, hides it from a restricted non-owner. A selection offers **Move to…** only when every item passes, and a drag onto a folder goes only where **Move to…** would. A flat view, such as a filter or an app's document list, has no folder chain and attaches no by-name check, so the server decides that there.

Accepted: the browser works out write by name itself, with the server's `holdsByName`, rather than reading a flag the API serves. It already holds the access lists, a served flag would be a second copy that can go stale, and the server still checks every share, move and mail. Reopen if the rule ever needs data the browser does not hold.

Accepted: the browser is stricter than the server for an entry that grants write without read on a folder above one the person can't read. Their breadcrumb stops below that folder, so **Move to…** and **Share** are hidden though the server would allow them. Handing the browser that folder would show it a folder the person may not read. Reopen if write-only entries become something people make.

### Design Decisions

Accepted: **Editors can share** is per item, not inherited, for sharing and moving alike. So an item inside a restricted folder, without the flag of its own, can still be shared or moved by an editor by name. It matches Google Drive and keeps the check on the item alone. Reopen if owners expect a folder's flag to cover what is in it.

**Self-removal is a delete, not an ACL edit.** A restricted editor cannot touch the ACL at all; the only thing they can do is leave, and that rides on `deletePath` so the ACL route keeps one rule.

**Visibility blocked too.** An editor cannot flip a restricted file to `public-read` or `link`, and a link-only editor can't flip any: same route, same check.

**Team members are co-owners.** No team user logs in, so team members always arrive through `SharedDrive`. `isEffectiveOwner()` uses `parseOwnerId()` plus pre-fetched `memberships.teamIds` to grant them full ACL control on team paths, including toggling the flag itself.

Integration tests: `apps/api/src/test/acl/acl-bubbling.test.ts`, `apps/api/src/test/acl/sharing-restricted.test.ts`, `apps/api/src/test/acl/share-by-name.test.ts`.

See: [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for team ACL details, [CHAT.md](CHAT.md) for the chat system, [SERVER-SETTINGS.md](SERVER-SETTINGS.md) for the email-notification settings, [SCALABILITY.md](SCALABILITY.md) for the home relay, [GUEST-ACCESS.md](GUEST-ACCESS.md) for guests and the share registry, [COLLAB.md](COLLAB.md) for live collab sockets
