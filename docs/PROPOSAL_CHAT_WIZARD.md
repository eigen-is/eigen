# Proposal: New-Chat Wizard

> **Status — revised draft v2, 2026-07-17.** No code yet. v1 (2026-07-14) was fact-checked against the
> codebase and against how Signal, WhatsApp, Telegram, Slack, and Google Chat design their new-chat
> flows; this revision corrects the wrong facts, resolves the open questions, and adjusts the UX to
> match messenger conventions. Covers: a create-chat dialog (people + name + location),
> open-don't-duplicate behaviour for exact member matches, a default `Chats` folder, and a
> "Start chat" entry point in Contacts.

## Problem statement

Creating a chat today is a bare drive-file create: the chat sidebar's "New chat" button
(`apps/chat/src/components/chat/chat-sidebar.tsx:97-104`) opens `DriveCreateEigenDoc type="chat"`
(`chat-sidebar.tsx:139-150`), which asks only for a file name and folder, drops the `.eigenchat` in the
drive root, and creates an empty room with one member (you). The chat empty state does the same
(`apps/chat/src/routes/_auth.index.tsx:52-58`). Inviting people is a separate follow-up step (share
dialog or `/invite`). Nothing stops you from creating a second, third, fourth chat with the same
person, and there is no way to start a chat from a contact.

## Prior art — how messengers do this

Researched 2026-07-17 (Signal, WhatsApp, Telegram, Slack, Google Chat — official docs). The patterns
that hold across all five:

- **People-first, zero-friction 1:1.** The new-chat action is a person picker, never a form. Pick a
  person → you are in the thread. No app has a naming step, a location step, or a create button for
  a 1:1.
- **1:1 duplicates are impossible by design**, everywhere. Slack and Google Chat extend this to
  unnamed group DMs: selecting a member set that already has a conversation *opens it* (Slack's
  `conversations.open` returns the existing conversation). No app shows a "you already have a chat
  with these people — open it?" prompt; the existing thread is simply reused.
- **Naming appears only for durable named entities** (groups/channels/spaces). Even then it splits:
  Signal and Telegram require a group name; WhatsApp made it optional in 2023 (auto-named from
  members); Slack/Google Chat group DMs stay unnamed until deliberately promoted to a
  channel/space.
- **No app has a "where is this chat stored" concept.** Telegram Chat Folders and Slack sidebar
  sections are view filters, not locations.

Eigen's constraint: a chat *is* a named drive file, so it can never be fully people-first — every
chat structurally has a name and a location. That puts Eigen chats closer to Slack channels than to
DMs. The design consequence: surface as little of the file-ness as possible at creation time, and
adopt open-don't-duplicate semantics for exact matches instead of a suggestion panel.

## Goals

- One dialog that asks **who** (one or more internal users), **name** (prefilled, never blocking),
  and **where** (defaulting to a `Chats` folder, shown as one quiet line).
- **Open, don't duplicate**: when the picked set exactly matches an existing writable standalone
  chat — owned by you **or** shared with you — the primary action opens it. Creating anyway stays
  possible (chats are durable named files; intentional duplicates are legitimate, as with Slack
  channels).
- `Chats` folder seeded on drive initialization for new users, lazily created for existing users.
- Contacts app: "Start chat" on a contact / team member → exactly one writable match opens it
  directly; otherwise the wizard opens pre-filled and Create enters the chat.
- The whole flow lives in `packages/ui` + `packages/lib` so chat, contacts, and (later) any userinfo
  chip can trigger it.

## Non-goals (v1)

- Picking a **team** as chat partner (team chats keep their current home: team drives, where every
  team member is an implicit member — `drive.ts:895-905`). The wizard picks individual people only.
- Embedded comment-thread chats (`chat/General.eigenchat` inside eigendocs) — out of scope
  everywhere; the mime listing already excludes them (`excludeDocumentChildren`,
  `mount/helpers.ts:40-51`, applied in `mount.ts:1118-1140`).
- A native DM/member model. Membership stays what it is: the drive ACL, resolved on demand
  (`Drive.getEffectiveMembers`, `apps/api/src/lib/drive/drive.ts:867-908`).
- **Per-message activity timestamps.** Posting a message does not touch the drive `paths` row (see
  Current state), and adding a per-message metadata bump has real write/fan-out costs. v1 shows no
  "last activity" anywhere; a real activity time (which would also let the sidebar sort by recency)
  is a separate ROADMAP item.
- **Create-on-first-message.** The messenger north star — a draft room that only creates + shares
  the file when the first message is sent — is explicitly follow-up work, not v1 (see Follow-ups).
- Changing any stored format. Everything here is plain drive data + new routes; no migration
  (eigen.is formats are frozen).

## Current state (verified 2026-07-17)

- A standalone chat is a drive folder of `type='chat'` created via the generic
  `POST /drive/:ownerId/:mountId/folder/:pathId/create/:type` route (`apps/api/src/routes/drive.ts:92-108`)
  → `Drive.create` (`drive/drive.ts:263`) → `ChatRoom.create`. No member table — members are the ACL.
- ACL entries are `{id, read, write}` where `id` is a **lowercased email** or `team_<id>`
  (`packages/lib/src/types/drive.ts:1-5`; lowercasing in `normalizeACL`, `acl.ts:85-97`). The owner
  is implicit (not an ACL row; `acl.ts:8,27`). Effective members = path ACL + ancestor ACLs + team
  expansion + owner (`getEffectiveMembers`, emails only). **Each call is a full breadcrumb walk plus
  a `getTeamMembers` query per team entry** — the code flags this cost itself (`chat/chat.ts:154`).
- The sidebar list — `use-chat.ts:51` → `useAggregateMimeContent('application-eigenchat')`
  (`use-drive.ts:172`) → `GET /drive/:ownerId/mime/:mimeType?teams=1` (`routes/drive.ts:481-497`) →
  `aggregateMimeContents` (`drive/aggregate.ts:23`) — aggregates **own mounts + the shared-with-me
  mirror + team homes**, merged by id, sorted `updatedAt` desc. Mirror rows (`mounts/shared.db`,
  push-based fan-out, eventually consistent, dropped on trash) carry the chat's **direct ACL only**
  (`shared-with-me.ts:49,74`) and the owner's **id, not email** (`sharedschema.ts:11`).
- **`DrivePath` has no `modifiedAt`** — the field is `updatedAt` (`types/drive.ts:336-339`), and it
  bumps on **create and ACL changes only**. `ChatRoom.postMessage` writes only the chat's own
  `data.db` (`chat/chat.ts:120`); messages never touch the paths row. Any UI text implying message
  recency from `updatedAt` would be wrong.
- Sharing: `useUpdateACL` → `PUT …/path/:pathId/acl` (delta; `requireNonGuest`, `drive.ts:391-393`)
  → `updateACLDelta` (`drive.ts:775`) → `propagateSharedPathChange` (`acl-propagation.ts:150`). Per
  newly added member this fires **(a)** a share **email** (`composeShareEmail`,
  `acl-propagation.ts:80-97,165`, gated by server settings `userOnAclAdd`/`guestOnAclAdd`), **(b)** a
  home-relay push → mirror upsert + `DRIVE_ACL_SHARED` SSE + in-app notification "X shared a chat"
  (`shared-with-me.ts:81-91`). `Drive.inviteToChat` (`drive.ts:943,969`) grants
  `{read:true, write:true}` on an existing chat.
- Duplicate names **409** — `assertUniqueName` (`mount.ts:379-396`) plus an insert-race net; the
  `getUniqueFileName` auto-suffix is used only by upload/copy, not create.
- `visibility` is `'private' | 'public-read' | 'public-write'` (`types/drive.ts:45`), default
  `'private'`.
- `DriveLocationPicker mode="create"` (`packages/ui/.../drive/drive-location-picker.tsx`): the name
  `Input` (113-132) is independent of the location section (134-191: breadcrumb + collapsed "Change"
  + expandable `DriveBrowser`). Extracting the location section is clean; the work is making the
  three-part location (`ownerId`/`mountId`/`folderId`) a controlled value.
- People picking: `useContactSuggestions(query, onlyInternalMails, excludeEmails)`
  (`use-contact-suggestions.ts:11`) merges team members + personal contacts, dedups by lowercased
  email — **and returns nothing until `query.length >= 2`** (`:42`). The share dialog composes
  `ContactAddRow` + `UserItem` rows (`drive-access-list-edit.tsx:221,270`); removal there is a
  per-row `Select` → "Remove", not a hover-×. There is no people-chip component in `packages/ui`.
- Navigation: the chat app's room route is `/$ownerId/$mountId/$chatId` (`chat-sidebar.tsx:84-88`).
  `getChatRoomUrl` (`api.ts:92-93`) is **module-private**; cross-app navigation goes through
  `openDocument`/`getDocumentUrl` (`api.ts:186-199`) or the TanStack route.
- The only seeded folder today is the root (`ensureRootFolder`, `mount.ts:247-264`); the only
  reserved name is `.trash`. `getChildByName` exists (`mount.ts:323`, `Drive.getChildByName`
  `drive.ts:1147`).
- Contacts: `ContactDetailToolbar`'s dropdown has "Send email" (`contact-detail.tsx:60-65`);
  `TeamMemberDetailToolbar` is empty (`team-member-detail.tsx:7-9`). Personal contacts store
  `eigenId` — the internal user's id, or `''` for external contacts (`contacts/schema.ts:9`,
  `contacts.ts:324`). `useResolvedUser` is display-resolution only (falls back to the raw email) and
  cannot gate "is this an Eigen user".
- User lookup: `getUserById` / `getUserByEmail` (`lib/user/user.ts:21,16`) are local auth-DB reads.
- No existing route composes create + ACL; the closest primitive is `inviteToChat`. Related ROADMAP
  work: "Create/open resilience" wants `Drive.create` made atomic — the new create+share route
  should be written with that in mind.
- Existing chat hooks (`packages/lib/src/core/chat/hooks/use-chat.ts`): `chatKeys` (all/owner/
  messages), `useCreateChat` (`:112`, generic create route), `useInviteToChat` (`:129`),
  `useChatSections`/`useAllChats`. No by-members key or wizard hooks yet.

## UX

### The wizard dialog

One dialog, one form (house convention — no paged steps). Shared component
`ChatCreateWizard` in `packages/ui/src/components/layout/chat/`.

```
┌─ New chat ─────────────────────────────────────┐
│ With                                           │
│   [ Add person…                            ]   │
│   ◦ Alice Johnson   alice@eigen.is        ×    │
│                                                │
│ ┌────────────────────────────────────────────┐ │
│ │ 💬 You already have a chat with Alice:     │ │
│ │    Alice & Reinder · 2 members             │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ Name                                           │
│   [ Alice & Reinder                        ]   │
│                                                │
│ Location   My Drive › Chats          [Change]  │
│                                                │
│             [Cancel]  [Create anyway]  [Open]  │
└────────────────────────────────────────────────┘
```

(With no match the footer is `[Cancel] [Create]` and the panel is absent.)

- **With** — `ContactAddRow` feeding `UserItem` rows with a hover-× remove (new composition — the
  share dialog removes via a Select option and `UserItem` has no built-in remove affordance; the
  hover-× follows the AGENTS.md hover-icons pattern). Suggestions restricted to internal users
  (`onlyInternalMails=true`), self excluded via `excludeEmails`. **On open, before anything is
  typed, the picker lists team members** (messenger convention: your people are visible
  immediately). This needs an opt-in flag on `useContactSuggestions` allowing an empty-query
  team-member listing — the ≥2-char behaviour stays the default so the share dialog is unchanged.
  No free-text emails in v1 — chat partners must be Eigen users (incl. guests, who are ordinary
  users in ACL terms).
- **Match behaviour (open, don't duplicate)** — matches are computed debounced (~300 ms) against the
  picked set:
  - **Exactly one writable match** → the panel shows it, the primary button becomes **Open**
    (Enter opens it), and creation demotes to a secondary **Create anyway**.
  - **Multiple matches** → panel lists them (writable first, then read-only, `updatedAt` desc as a
    tiebreak) with a per-row **Open**; the primary button stays **Create**.
  - **Only read-only matches** → panel shows them labelled "view only"; primary stays **Create**.
    A chat you cannot post in is never the primary target.
  - The panel shows **name + member count only** — no "2d ago": `updatedAt` is share/create time,
    not message activity (see Current state), and showing it as recency would lie.
- **Name** — never blocks. One person: live default `<Their name> & <My name>` (e.g.
  `Alice & Reinder`) that keeps updating until the user edits the field (dirty flag). The file name
  is shared — Alice sees it too — so `Chat with Alice` is wrong from her side; both names read
  correctly from both sides. Two or more people: prefilled `Alice, Bob & Carol` (display names,
  editable — WhatsApp's optional-with-auto-name model; deliberate naming stays one click away,
  Create is never disabled). Names run through the existing drive name validation.
- **Location** — one quiet secondary line: `My Drive › Chats  [Change]`, expanding the extracted
  `DriveLocationField` (see Frontend). No messenger has a location concept; this is the minimum a
  drive-file chat needs, and it must not compete visually with the people field. v1 restricts the
  destination to the user's own mounts: storing a chat in a team drive silently makes the whole
  team members, which contradicts "a chat with exactly these people".
- **Create** — one backend call (create + share, see routes), then navigate into the room via the
  chat route `/$ownerId/$mountId/$chatId` (not `getChatRoomUrl`, which is module-private). Other
  members' sidebars follow via the existing ACL fan-out → shared-mirror → SSE invalidation path.
- Hidden for `role === 'guest'` (`useIsGuest`). Guests can't share (`requireNonGuest` on the ACL
  route), so the wizard can never succeed for them. **Deliberate capability removal**: since the
  wizard replaces the plain create dialog in the chat app, guests lose the "New chat" button
  entirely — acceptable, a solo chat is useless and guests join chats via shares.

Replaces `DriveCreateEigenDoc type="chat"` in the chat sidebar and the chat empty state. The drive
app's generic **New** menu keeps the plain create dialog in v1 (decision 3).

### Duplicate detection semantics

"Same members" means: the **effective member email set** of the candidate equals
`{me} ∪ picked`, all emails lowercased. Candidates are the standalone chats the user can already see
(own mounts + shared-with-me mirror). "Writable" means I can post: I own it, or my ACL entry has
`write: true`.

Excluded from matching (member set is not a fixed set of people):

- chats with `visibility !== 'private'` (public link = unbounded members; values are
  `public-read`/`public-write`),
- chats with any `team_*` ACL entry (dynamic membership; matching today's expansion would silently
  diverge tomorrow),
- chats on team-owned drives (`ownerId` starts with `team_` — implicit all-team membership).

Known approximation: for **shared-with-me** candidates the mirror row only carries the chat's
*direct* ACL, not ancestor-inherited entries, so a foreign chat that gains extra members purely via
a shared parent folder can false-positively match. Accepted for v1: the wizard itself always shares
the chat path directly, so wizard-created chats always match exactly; the panel suggests, it does
not guard. (Fixing it properly needs a new `pullEffectiveMembers` home-relay call per candidate —
deferred until it bites.) The mirror is also eventually consistent, so a *just*-shared chat may be
missed for a moment — same acceptance.

### Contacts entry point

- `ContactDetailToolbar`'s dropdown gets **Start chat** next to **Send email**; `TeamMemberDetail`
  (toolbar currently empty) gets the same action. Shown only when the contact resolves to an Eigen
  user: team members always do; personal contacts qualify when `eigenId !== ''` (the contacts
  schema stores the internal user id, or `''` for external — `useResolvedUser` is display-only and
  can't gate this).
- Click → `useStartChatWith(email)`:
  1. fetch the by-members match for `{me, them}` once (`queryClient.fetchQuery`),
  2. exactly one **writable** match → navigate straight to the chat (same tab),
  3. no match → open `ChatCreateWizard` pre-filled with that person (name defaulted, location
     defaulted) — Create then enters the room,
  4. multiple matches, or only read-only matches → open the wizard with the panel showing them.
- Follow-up (explicitly wanted, not v1): a `chatLink`/`onStartChat` prop on `UserItem` — sibling of
  the existing `mailLink` (`user-item.tsx:16`) — would propagate the action through `UserNameCard`
  hovercards everywhere (comments, chat message list, activity rows). Same hook, zero new flow. A
  command-palette "Start chat with …" action on contact hits falls out of the same hook too.

### The `Chats` folder

- **New mounts**: `ensureRootFolder` additionally seeds a plain folder `Chats` under the root — only
  when it just created the root, and only for default user mounts (not team mounts, not extra/S3
  mounts).
- **Existing users / deleted folder**: the create route resolves the default parent lazily —
  `getChildByName(rootId, 'Chats')`; on miss (or if the name is taken by a non-folder → fall back to
  root), create it. It stays an ordinary folder: renameable, movable, deletable; we resolve by name
  per use and never pin an id (decision 4: silent recreate). English-only product → literal `Chats`,
  no i18n.
- No backfill migration needed; nothing frozen is touched.

## Backend design

### New routes (`apps/api/src/routes/chat.ts`)

**`GET /chat/:ownerId/rooms/by-members?emails=a@x.y,b@x.y`** — `requireSelf(ownerId, user.id)`.
Returns `{ matches: { path: DrivePath, canWrite: boolean }[] }` (shared type in
`packages/lib/src/types/chat.ts`), writable first, then `updatedAt` desc.

```
target = lowercase(emails) ∪ {user.email}
own:    per mount, getPathsByMimeType(DRIVE_MIME_CHAT, excludeDocumentChildren)
        → skip non-private visibility / team_* entries
        → cheap pre-filter on the DIRECT acl (direct emails ⊆ target, |direct|+1 ≥ |target|)
        → only survivors run the full getEffectiveMembers walk; emails == target → match
shared: listSharedWithMeByMimeType(sharedDb, DRIVE_MIME_CHAT)
        → skip team-owned ownerId / team_* entries / non-private visibility
        → {owner email via getUserById(ownerId)} ∪ direct acl emails == target → match
        → canWrite from my own acl entry
```

The pre-filter matters: `getEffectiveMembers` is a full breadcrumb + team walk per call (the code
flags it, `chat/chat.ts:154`); with the direct-ACL screen only a handful of candidates per request
pay for the walk. All in-process on the caller's Home — mirror reads plus local auth-DB lookups, no
cross-home calls, per the SCALABILITY rule.

**`POST /chat/:ownerId/:mountId/rooms {parentId?, fileName, members: string[]}`** — create + share
as one server-side sequence:

1. resolve/ensure the `Chats` folder when `parentId` is omitted;
2. `Drive.create(…, 'chat', user)`;
3. merge `{id: email.toLowerCase(), read: true, write: true}` per member through the same ACL-update
   path the share dialog uses — **with the share email suppressed** (thread a notify option through
   `updateACL` → `propagateSharedPathChange` so the mirror fan-out, `DRIVE_ACL_SHARED` SSE, and the
   in-app "X shared a chat" notification still fire, and only `composeShareEmail` is skipped). A
   "someone shared a file with you" email for being added to a chat is wrong-tone and spammy for
   groups; the first message is the real notification. (Chat-specific email copy can come later if
   wanted.)
4. **on failure of step 3, hard-delete the freshly created container before rethrowing** — the
   invariant is "a wizard chat is born shared", and a created-but-unshared orphan is worse than a
   clean error. (Overlaps ROADMAP "Create/open resilience", which wants `Drive.create` atomic.)

Returns the created `DrivePath`. Name collisions surface the existing 409.

Rejected alternative — FE composing the two existing endpoints (`create` + `PUT …/acl`): two
mutations with a partial-failure gap the client can't clean up, and the ensure-`Chats`-folder logic
would leak into the client.

### Frontend (`packages/lib` + `packages/ui`)

- `chatKeys.byMembers(ownerId, sortedEmails)` + `useFindChatByMembers(ownerId, emails)` — enabled
  when `emails.length > 0`, `staleTime` ~30 s; drives both the wizard panel and the contacts
  direct-open.
- `useCreateChatRoom(ownerId, mountId)` — mutation for the new POST; `onSuccess` invalidates the
  chat list keys (supersedes `useCreateChat` for the wizard path).
- `useStartChatWith()` — the contacts-side orchestrator (fetch → navigate | open wizard).
- `useContactSuggestions` — opt-in flag for empty-query team-member listing (wizard only; share
  dialog unchanged).
- `ChatCreateWizard` in `packages/ui/src/components/layout/chat/` composing `ContactAddRow`,
  `UserItem` rows (+ new hover-× remove), the name `Input`, and the location line. The location
  section (breadcrumb + expandable `DriveBrowser`) gets extracted from `DriveLocationPicker` into a
  shared, controlled `DriveLocationField` (value = `{ownerId, mountId, folderId}`) used by both — a
  legit extraction, two real consumers, verified untangled from the name field.

## Edge cases

- **Zero people picked** → Create disabled (the only time it is). Self is unpickable
  (`excludeEmails`).
- **Name collision** in the target folder → 409 surfaces inline; for prefilled defaults, append a
  counter client-side (`Alice & Reinder 2`). Rarer than in v1 of this proposal, since the exact-match
  path now opens instead of creating.
- **Matching chat in trash** → invisible by design (listings filter trashed, mirror rows are deleted
  on trash) → wizard creates a new chat. Fine: restore would resurface two chats, but matching is
  best-effort.
- **Renamed chats** still match — matching is member-based, never name-based.
- **Members added later** (`/invite` or the share dialog) — member sets are mutable after creation.
  Matching always uses the *current* effective set, so a grown chat stops matching its original pair
  and starts matching the new set — correct by construction. A defaulted name (`Alice & Reinder`)
  goes stale once Carol joins — accepted: rename is always available, and the follow-up
  counterpart-name display derives from the ACL, not the file name.
- **Pending/unregistered emails** in a chat's ACL make it unmatchable unless the same email is
  picked — can't happen via the internal-only picker.
- **Read-only matches** are shown ("view only") but never auto-opened and never the primary action.

## Decisions (previously open questions)

1. **Exact duplicates** — allowed, but the primary action on an exact writable match is **Open**;
   creation demotes to "Create anyway". Matches Slack `conversations.open` semantics while keeping
   intentional duplicates one click away.
2. **Read-only matches** — shown, deprioritized below writable, never primary/auto-open.
3. **Drive New menu** — keeps the plain name+folder dialog in v1; swap is a follow-up.
4. **Deleted `Chats` folder** — silently recreated on next default-location use. Resolve-by-name
   respects the user's structure; remembering a deletion is statefulness with no payoff.
5. **Superset hints** ("your Standup chat contains these people plus Carol") — no. v1 is exact-only;
   none of the researched apps do near-miss suggestions either.
6. **Share email on wizard create** — suppressed (in-app notification + SSE remain). Flipping this
   back is one flag if it turns out people miss invitations.
7. **No recency in the match panel** — `updatedAt` is share/create time; showing it as activity
   would mislead. Real per-message activity (also unlocking sidebar sort-by-recency) is a separate
   ROADMAP item.

## Phased implementation

1. **Backend** — `Chats` seeding in `ensureRootFolder`, lazy ensure, both routes (incl. direct-ACL
   pre-filter, email suppression flag, failure cleanup), shared types. Tests in `apps/api/src/test/`
   (new `chat-wizard.test.ts`) with alice/bob/charlie: exact-set match, owner-implicit,
   inherited-ACL own-chat match, team-entry exclusion, public exclusion, team-drive exclusion, trash
   exclusion, shared-with-me match (incl. owner-email resolution), writable-vs-read-only flag,
   create-with-members ACL + in-app notification + **no share email**, 409 on duplicate name,
   Chats-folder seed + lazy recreate.
2. **Wizard** — `DriveLocationField` extraction, `useContactSuggestions` empty-query flag,
   `ChatCreateWizard`, hooks; swap the chat sidebar + empty-state entry points. Browser verification
   per VERIFICATION.md (two test users, both directions of the match check, Open-vs-Create-anyway
   footer states, group-name prefill).
3. **Contacts** — `useStartChatWith`, toolbar/dropdown actions, `eigenId`-based gating.
4. **Follow-ups (separate cycles)** —
   - **North star: create-on-first-message.** A client-side draft room that creates + shares the
     file only when the first message is sent — removes the create step entirely and kills any
     notification-before-content problem at the root.
   - **Counterpart-name display for 1:1 chats** in the sidebar (exactly 2 effective members,
     private): render the other person's name + avatar instead of the file name — display-layer
     only, using the direct ACL already present on listing rows. This is how every messenger renders
     1:1s and makes the file name nearly invisible.
   - `UserItem` `chatLink` prop → `UserNameCard` hovercards everywhere; command-palette "Start
     chat" action; drive New-menu swap; team-as-member support if wanted; per-message activity
     timestamp (ROADMAP).

Docs in the same cycle: update `docs/CHAT.md` — it documents a nonexistent
`POST /drive/:o/:m/folder/:pathId/chat` create route (`CHAT.md:66`; the real route is
`.../create/:type`) — adding the wizard + by-members semantics, and the AGENTS.md FE table row for
chat hooks.

## Files

| Area | Files |
|---|---|
| Routes | `apps/api/src/routes/chat.ts` (2 new routes) |
| Backend lib | `apps/api/src/lib/mount/mount.ts` (`ensureRootFolder` seed), `apps/api/src/lib/chat/chat.ts` or `lib/drive/drive.ts` (find-by-members + create-with-members helpers), `apps/api/src/lib/drive/acl-propagation.ts` (share-email suppression option) |
| Shared types | `packages/lib/src/types/chat.ts` (`ChatMatch`) |
| Hooks | `packages/lib/src/core/chat/hooks/use-chat.ts` (`chatKeys.byMembers`, `useFindChatByMembers`, `useCreateChatRoom`, `useStartChatWith`), `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` (empty-query flag) |
| UI | `packages/ui/src/components/layout/chat/chat-create-wizard.tsx` (new), `packages/ui/src/components/layout/drive/drive-location-picker.tsx` (`DriveLocationField` extraction) |
| Chat app | `apps/chat/src/components/chat/chat-sidebar.tsx`, `apps/chat/src/routes/_auth.index.tsx` |
| Contacts app | `apps/contacts/src/components/contacts/contact-detail.tsx`, `team-member-detail.tsx` |
| Tests | `apps/api/src/test/chat-wizard.test.ts` (new) |
| Docs | `docs/CHAT.md` (also fix the stale create-route), `AGENTS.md` |
