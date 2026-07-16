# Proposal: New-Chat Wizard

> **Status — draft, 2026-07-14.** Research done, no code yet. Covers: a create-chat dialog (people +
> name + location), duplicate-chat detection ("you already have a chat with exactly these people"),
> a default `Chats` folder, and a "Start chat" entry point in Contacts.

## Problem statement

Creating a chat today is a bare drive-file create: the chat sidebar's "New chat" button opens
`DriveCreateEigenDoc type="chat"` (`apps/chat/src/components/chat/chat-sidebar.tsx:159-170`), which asks
only for a file name and folder, drops the `.eigenchat` in the drive root, and creates an empty room with
one member (you). Inviting people is a separate follow-up step (share dialog or `/invite`). Nothing stops
you from creating a second, third, fourth chat with the same person, and there is no way to start a chat
from a contact.

## Goals

- One dialog that asks **who** (one or more internal users), **name** (defaulted for 1:1, required for
  groups), and **where** (defaulting to a `Chats` folder).
- While picking people, detect an existing standalone chat — owned by you **or** shared with you — whose
  member set is exactly you + the picked people, and suggest opening it instead.
- `Chats` folder seeded on drive initialization for new users, lazily created for existing users.
- Contacts app: "Start chat" on a contact / team member → if a matching chat exists, open it directly;
  otherwise open the wizard pre-filled and enter the chat after create.
- The whole flow lives in `packages/ui` + `packages/lib` so chat, contacts, and (later) any userinfo chip
  can trigger it.

## Non-goals (v1)

- Picking a **team** as chat partner (team chats keep their current home: team drives, where every team
  member is an implicit member — `drive.ts:890-900`). The wizard picks individual people only.
- Embedded comment-thread chats (`chat/General.eigenchat` inside eigendocs) — out of scope everywhere;
  the mime listing already excludes them (`excludeDocumentChildren`, `mount/helpers.ts:40-51`).
- A native DM/member model. Membership stays what it is: the drive ACL, resolved on demand
  (`Drive.getEffectiveMembers`, `apps/api/src/lib/drive/drive.ts:862-903`).
- Changing any stored format. Everything here is plain drive data + new routes; no migration
  (eigen.is formats are frozen).

## Current state (facts the design builds on)

- A standalone chat is a drive folder of `type='chat'` created via
  `POST /drive/:o/:m/folder/:pathId/create/chat {fileName}` (`apps/api/src/routes/drive.ts:92-98` →
  `Drive.create` → `ChatRoom.create`). No member table — members are the ACL.
- ACL entries are `{id, read, write}` where `id` is a **lowercased email** or `team_<id>`
  (`packages/lib/src/types/drive.ts:1-5`, `acl.ts:85-97`). The owner is implicit (not an ACL row).
  Effective members = path ACL + ancestor ACLs + team expansion + owner
  (`getEffectiveMembers`, emails only).
- The sidebar list — `useChats(ownerId)` → `GET /drive/:ownerId/mime/application-eigenchat`
  (`drive.ts:710-726`) — already aggregates **own mounts + the shared-with-me mirror** and returns
  `DrivePath[]` including each path's direct `acl`. The mirror (`mounts/shared.db`, push-based fan-out)
  is eventually consistent and drops trashed shares.
- Sharing primitives: `useUpdateACL` delta (`PUT …/path/:pathId/acl`) with share-email notifications via
  `emailNewlyAddedAclEntries`; chat-specific `Drive.inviteToChat` grants `{read:true, write:true}`.
- `DriveLocationPicker mode="create"` (`packages/ui/.../drive/drive-location-picker.tsx`) already renders
  name + collapsed-breadcrumb location + expandable `DriveBrowser` — the layout the wizard extends.
- People picking: `useContactSuggestions(query, onlyInternalMails, excludeEmails)` merges team members +
  personal contacts; the drive share dialog composes it via `ContactAddRow` + `UserItem` rows
  (`drive-access-list-edit.tsx`) — the picker pattern to reuse. There is no chip/pill component.
- The only seeded folder today is the root (`ensureRootFolder`, `apps/api/src/lib/mount/mount.ts:247-264`);
  the only reserved name is `.trash`.

## UX

### The wizard dialog

One dialog, one form (house convention — no paged steps). Shared component
`ChatCreateWizard` in `packages/ui/src/components/layout/chat/`.

```
┌─ New chat ─────────────────────────────────────┐
│ With                                           │
│   [ Add person…                        ] [+]   │
│   ◦ Alice Johnson   alice@eigen.is        ×    │
│   ◦ Bob de Vries    bob@eigen.is          ×    │
│                                                │
│ ┌────────────────────────────────────────────┐ │
│ │ You already have a chat with these people: │ │
│ │ 💬 Standup · 3 members · 2d ago     [Open] │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ Name                                           │
│   [ Chat with Alice                      ]     │
│                                                │
│ Location   My Drive › Chats          [Change]  │
│                                                │
│                          [Cancel]  [Create]    │
└────────────────────────────────────────────────┘
```

- **With** — `ContactAddRow` (existing shared component) feeding a `UserItem` row list with hover-×
  remove, exactly the share-dialog pattern. Suggestions restricted to internal users
  (`onlyInternalMails=true`), self excluded via `excludeEmails`. No free-text emails in v1 — chat
  partners must be Eigen users (incl. guests, who are ordinary users in ACL terms).
- **Existing-chat panel** — appears (debounced ~300 ms) whenever the picked set matches ≥1 existing
  chat. Shows name, member count, last-activity (`formatTimeAgo(modifiedAt)`), newest first.
  **Open** navigates to the chat (`getChatRoomUrl`). It suggests, it does not block — Create stays
  enabled.
- **Name** — for one person: live default `Chat with <displayName>` that keeps updating until the user
  edits the field (dirty flag). For ≥2 people: empty + required; Create disabled until non-empty
  (group chats must be deliberately named).
- **Location** — defaults to the `Chats` folder (created on demand, see below); **Change** expands the
  same `DriveBrowser` section `DriveLocationPicker` uses. v1 restricts the destination to the user's own
  mounts: storing a chat in a team drive silently makes the whole team members, which contradicts
  "a chat with exactly these people".
- **Create** — one backend call (create + share, see routes), then navigate into the room. Other
  members' sidebars follow via the existing ACL fan-out → shared-mirror → SSE invalidation path.
- Hidden for `role === 'guest'` (guests can't share: `requireNonGuest` on the ACL route, so the wizard's
  share step can never succeed for them).

Replaces `DriveCreateEigenDoc type="chat"` in the chat sidebar and the chat empty state
(`_auth.index.tsx:41-63`). The drive app's generic **New** menu keeps the plain create dialog in v1
(open question 3).

### Duplicate detection semantics

"Same members" means: the **effective member email set** of the candidate equals
`{me} ∪ picked`, all emails lowercased. Candidates are the standalone chats the user can already see
(own mounts + shared-with-me mirror — i.e. exactly the sidebar list's scope).

Excluded from matching (member set is not a fixed set of people):

- chats with `visibility !== 'private'` (public link = unbounded members),
- chats with any `team_*` ACL entry (dynamic membership; matching today's expansion would silently
  diverge tomorrow),
- chats on team-owned drives (`ownerId` starts with `team_` — implicit all-team membership).

Permission level is ignored for matching in v1: a chat where a picked person is read-only still counts
as "a chat with these people" (open question 2).

Known approximation: for **shared-with-me** candidates the mirror row only carries the chat's *direct*
ACL, not ancestor-inherited entries, so a foreign chat that gains extra members purely via a shared
parent folder can false-positively match. Accepted for v1: the wizard itself always shares the chat
path directly, so wizard-created chats are always matched exactly; the panel is a suggestion, not a
guard. (Fixing it properly needs a new `pullEffectiveMembers` home-relay call per candidate —
deferred until it bites.) The mirror is also eventually consistent, so a *just*-shared chat may be
missed for a moment — same acceptance.

### Contacts entry point

- `ContactDetailToolbar`'s dropdown (`contact-detail.tsx:60-65`) gets **Start chat** next to
  **Send email**; `TeamMemberDetail` (toolbar currently empty) gets the same action. Shown only when
  the contact resolves to an Eigen user — team members always do; personal contacts qualify when
  `eigenId` is non-empty or their email resolves internally (`useResolvedUser`).
- Click → `useStartChatWith(email)`:
  1. fetch the by-members match for `{me, them}` once (`queryClient.fetchQuery`),
  2. exactly one match → navigate straight to the chat app (`getChatRoomUrl`, same tab),
  3. no match → open `ChatCreateWizard` pre-filled with that person (name defaulted, location
     defaulted) — Create then enters the room,
  4. multiple matches → open the wizard with the suggestion panel showing all of them.
- Follow-up (explicitly wanted, not v1): a `chatLink`/`onStartChat` prop on `UserItem` — sibling of the
  existing `mailLink` — would propagate the action through `UserNameCard` hovercards everywhere
  (comments, chat message list, activity rows). Same hook, zero new flow. A command-palette
  "Start chat with …" action on contact hits falls out of the same hook too.

### The `Chats` folder

- **New mounts**: `ensureRootFolder` additionally seeds a plain folder `Chats` under the root — only
  when it just created the root, and only for default user mounts (not team mounts, not extra/S3
  mounts).
- **Existing users / deleted folder**: the create route resolves the default parent lazily —
  `getChildByName(rootId, 'Chats')`; on miss (or if the name is taken by a non-folder → fall back to
  root), create it. It stays an ordinary folder: renameable, movable, deletable; we resolve by name
  per use and never pin an id. English-only product → literal `Chats`, no i18n.
- No backfill migration needed; nothing frozen is touched.

## Backend design

### New routes (`apps/api/src/routes/chat.ts`)

**`GET /chat/:ownerId/rooms/by-members?emails=a@x.y,b@x.y`** — `requireSelf(ownerId, user.id)`.
Returns `{ matches: DrivePath[] }` (shared type in `packages/lib/src/types/chat.ts`), newest
`modifiedAt` first.

```
target = lowercase(emails) ∪ {user.email}
own:    per mount, getPathsByMimeType(DRIVE_MIME_CHAT, excludeDocumentChildren)
        → skip non-private visibility / team_* entries
        → getEffectiveMembers(mountId, pathId) emails == target → match
shared: listSharedWithMeByMimeType(sharedDb, DRIVE_MIME_CHAT)
        → skip team-owned ownerId / team_* entries / non-private visibility
        → {owner email (resolved from auth DB)} ∪ direct acl emails == target → match
```

All in-process on the caller's Home — no cross-home reads, per the SCALABILITY rule.

**`POST /chat/:ownerId/:mountId/rooms {parentId?, fileName, members: string[]}`** — create + share as
one server-side sequence: resolve/ensure the `Chats` folder when `parentId` is omitted;
`Drive.create(…, 'chat', user)`; merge `{id: email.toLowerCase(), read: true, write: true}` per member
through the same ACL-update path the share dialog uses (so propagation, shared-mirror fan-out, and
share notifications all fire normally). Returns the created `DrivePath`.

Rejected alternative — FE composing the two existing endpoints (`create` + `PUT …/acl`): two mutations
with a partial-failure gap (chat created but unshared), and the ensure-`Chats`-folder logic would leak
into the client. One route keeps the invariant "a wizard chat is born shared".

### Frontend (`packages/lib` + `packages/ui`)

- `chatKeys.byMembers(ownerId, sortedEmails)` + `useFindChatByMembers(ownerId, emails)` — enabled when
  `emails.length > 0`, `staleTime` ~30 s; drives both the wizard panel and the contacts direct-open.
- `useCreateChatRoom(ownerId, mountId)` — mutation for the new POST; `onSuccess` invalidates the chat
  list keys (like `useCreateChat` today, which it supersedes for the wizard path).
- `useStartChatWith()` — the contacts-side orchestrator (fetch → navigate | open wizard).
- `ChatCreateWizard` in `packages/ui/src/components/layout/chat/` composing `ContactAddRow`,
  `UserItem` rows, the name `Input`, and the location section. The location section (breadcrumb +
  expandable `DriveBrowser`) gets extracted from `DriveLocationPicker` into a shared `DriveLocationField`
  used by both — a legit extraction, two real consumers.

## Edge cases

- **Zero people picked** → Create disabled. Self is unpickable (`excludeEmails`).
- **Name collision** in the target folder → surface the server error inline; for the auto-default,
  append a counter client-side (`Chat with Alice 2`). Verify `Drive.create`'s duplicate behavior at
  implementation time.
- **Matching chat in trash** → invisible by design (listings filter `trashedAt`, mirror rows are
  deleted on trash) → wizard creates a new chat. Fine: restore would resurface two chats, but suggestion
  is best-effort.
- **Renamed chats** still match — matching is member-based, never name-based.
- **Pending/unregistered emails** in a chat's ACL make it unmatchable unless the same email is picked —
  can't happen via the internal-only picker.
- **Read-only viewer matches**: suggested anyway (v1); opening a chat you can't post in is still the
  existing chat with those members.

## Phased implementation

1. **Backend** — `Chats` seeding in `ensureRootFolder`, lazy ensure, both routes, shared types.
   Tests in `apps/api/src/test/` with alice/bob/charlie: exact-set match, owner-implicit, inherited-ACL
   own-chat match, team-entry exclusion, public exclusion, trash exclusion, shared-with-me match,
   create-with-members ACL + notification assertions.
2. **Wizard** — `DriveLocationField` extraction, `ChatCreateWizard`, hooks; swap the chat sidebar +
   empty-state entry points. Browser verification per VERIFICATION.md (two test users, both directions
   of the duplicate check).
3. **Contacts** — `useStartChatWith`, toolbar/dropdown actions, gating on resolvable users.
4. **Follow-ups (separate cycle)** — `UserItem` `chatLink` prop → `UserNameCard` hovercards everywhere;
   command-palette "Start chat" action; drive New-menu swap; team-as-member support if wanted.

Docs in the same cycle: update `docs/CHAT.md` (it still documents a nonexistent dedicated
`folder/:pathId/chat` create route; add the wizard + by-members semantics) and the AGENTS.md FE table row
for chat hooks.

## Open questions

1. **Create-anyway for an exact duplicate 1:1** — proposal says allow (suggest, don't block). Confirm
   that intentional duplicates ("project chat with the same person") are wanted.
2. **Read-only matches** — suggest a chat where you or a picked member can only read? Proposed: yes,
   it's still "the chat with these people"; could deprioritize below writable matches instead.
3. **Drive New menu** — keep the plain name+folder dialog for chat there, or swap in the wizard with
   `defaultFolderId` = current folder? Proposed: keep plain in v1, swap in the follow-up cycle.
4. **Deleted `Chats` folder** — silently recreate on next wizard use (proposed: yes, simple and
   predictable) or fall back to drive root to respect the deletion?
5. **Suggestion scope for near-misses** — v1 only shows *exact* matches. Worth also hinting supersets
   ("your Standup chat contains these people plus Carol")? Proposed: no, keep v1 crisp.

## Files

| Area | Files |
|---|---|
| Routes | `apps/api/src/routes/chat.ts` (2 new routes) |
| Backend lib | `apps/api/src/lib/mount/mount.ts` (`ensureRootFolder` seed), `apps/api/src/lib/drive/drive.ts` or `lib/chat/chat.ts` (find-by-members + create-with-members helpers) |
| Shared types | `packages/lib/src/types/chat.ts` |
| Hooks | `packages/lib/src/core/chat/hooks/use-chat.ts` (keys, `useFindChatByMembers`, `useCreateChatRoom`, `useStartChatWith`) |
| UI | `packages/ui/src/components/layout/chat/chat-create-wizard.tsx` (new), `packages/ui/src/components/layout/drive/drive-location-picker.tsx` (`DriveLocationField` extraction) |
| Chat app | `apps/chat/src/components/chat/chat-sidebar.tsx`, `apps/chat/src/routes/_auth.index.tsx` |
| Contacts app | `apps/contacts/src/components/contacts/contact-detail.tsx`, `team-member-detail.tsx` |
| Tests | `apps/api/src/test/chat-wizard.test.ts` (new) |
| Docs | `docs/CHAT.md`, `AGENTS.md` |
