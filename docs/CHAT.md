# Chat System

> **TLDR**: Chat rooms are `.eigenchat` Drive folders with own `data.db` (SQLite) + `media/`. Not Yjs — append-only
> messages use SQLite for pagination/indexing. ACL inherited from Drive. 80+ MUD-inspired slash commands (emotes,
> whisper, invite). Embedded chats auto-created inside docs/stickies. Mention notifications via notification center.

## Design

- **Chat = Room**: Each `.eigenchat` is a single room with its own database
- **MUD-inspired**: Slash commands, emotes, whispers
- **Drive-based**: ACL, storage, sharing all inherited from Drive
- **Real-time**: SSE for notifications, no new infrastructure

## Storage

```
my-chat.eigenchat/
├── data.db              (messages + read state)
└── media/               (uploaded attachments)
```

**Embedded in docs/stickies**: Created automatically with a default "General" chat:

```
my-document.eigendoc/
├── data.db              (Yjs)
├── media/
└── chat/
    └── General.eigenchat/
```

## Schema (per chat `data.db`)

### messages

| Column        | Type    | Description                                |
|---------------|---------|--------------------------------------------|
| `id`          | TEXT PK | UUID                                       |
| `authorId`    | TEXT    | User ID                                    |
| `authorEmail` | TEXT    | Author email address                       |
| `type`        | TEXT    | `message` / `emote` / `whisper` / `system` |
| `content`     | TEXT    | Plain text (not Markdown)                  |
| `attachments` | TEXT    | JSON array of file names                   |
| `whisperTo`   | TEXT    | Email or user ID (whisper only)            |
| `replyTo`     | TEXT    | Message ID (threaded replies)              |
| `editedAt`    | INTEGER | Null if not edited                         |
| `deletedAt`   | INTEGER | Soft delete                                |
| `createdAt`   | INTEGER | Timestamp                                  |

Indexes: `createdAt`, `replyTo`, `authorId`.

### read_state

| Column              | Type    | Description       |
|---------------------|---------|-------------------|
| `userId`            | TEXT PK | User ID           |
| `lastReadMessageId` | TEXT    | Last read message |
| `lastReadAt`        | INTEGER | Timestamp         |

## API Routes

Chat router: `apps/api/src/routes/chat.ts`, prefix `/chat/`, all `{auth: true}`.
The generic create-chat route lives in the Drive router: `apps/api/src/routes/drive.ts`.

```
POST   /drive/:ownerId/:mountId/folder/:pathId/create/:type           (create chat — generic Drive route, type=chat)
GET    /chat/:ownerId/rooms/by-members?emails=a@x,b@y                 (wizard duplicate lookup — self-only)
POST   /chat/:ownerId/:mountId/rooms                                  (wizard create + share — self or team)
GET    /chat/:ownerId/:mountId/:chatId/messages?before=&limit=
POST   /chat/:ownerId/:mountId/:chatId/messages
PATCH  /chat/:ownerId/:mountId/:chatId/messages/:messageId
DELETE /chat/:ownerId/:mountId/:chatId/messages/:messageId
POST   /chat/:ownerId/:mountId/:chatId/invite
POST   /chat/:ownerId/:mountId/:chatId/read
```

The `:chatId` routes go through `getSharedDrive()` (ACL checks; write routes additionally check `canWrite`). The two
`rooms` routes are the new-chat wizard's backend — the GET is self-only (`requireSelf` + raw `getDrive`, like
`/shared/by-me`) since it reads the caller's own mounts; the POST accepts the caller's own ownerId (`requireSelf`) or
a team ownerId (`requireTeamAccess` + the team home's drive) and additionally requires `requireNonGuest` (guests can't
share, so the server hard-rejects them too, not just the hidden UI). See [New-Chat Wizard](#new-chat-wizard) below.

## ACL

Inherited from Drive. `read` = view messages. `write` = post messages. `owner` = manage ACL.
Chat membership is coupled to Drive ACLs by design: if you can see a folder, you're in its chat.

Chat invites (`/invite` command or `POST .../invite`) bubble ACL to the outermost container document via
`findContainerPath()`. See [ACL.md](ACL.md) for details on invite propagation and `getEffectiveMembers`.

## New-Chat Wizard

`ChatCreateWizard` (`packages/ui/src/components/layout/chat/chat-create-wizard.tsx`) is a two-step dialog for
starting a chat with picked people (or a whole team) instead of the bare drive-file create: step 1 picks who
(share-dialog-style `ContactAddRow`, guest emails allowed, "Team chat" footer dropdown) and applies the
open-vs-create rule (any existing match → primary opens the first, "Create new chat" advances); step 2 confirms name
and location. It replaces `DriveCreateEigenDoc type="chat"` at the chat sidebar's "New chat" button and the chat
empty state; contacts trigger it too (see Entry points). Hidden for guests (`useIsGuest`) — they can't share, so it
can never succeed for them.
**Deliberately NOT wired into Drive** (product decision 2026-07-19): Drive is a place-first surface, so its `+ New`
menu, list context menu, and mobile toolbar create a chat like any other eigen type — plain
`DriveCreateEigenDoc type="chat"` in the browsed folder, on whichever drive/mount you're standing in. That keeps the
file model visible: a drive-created chat starts with exactly the members its location's ACL implies (inherited from
the folder, or none), no people picker in the way. The wizard — with open-don't-duplicate and the `chats`-folder
default — belongs to the person-first surfaces (chat app, contacts, future profile views) where the intent is "talk
to someone", not "create a file here".

### Design decisions

Why the wizard looks the way it does. Settled 2026-07-19 after a prior-art round on Signal, WhatsApp, Telegram,
Slack and Google Chat.

- **A chat is a file, so Eigen sits closer to Slack channels than to person-chats.** All five messengers are
  person-first: the new-chat action is a picker, there is no name step and no location step, and 1:1 duplicates are
  impossible by design. An Eigen chat structurally has a name and a place in Drive, so it can never be fully
  person-first. The answer is to show as little file-ness as possible at creation time and to copy Slack's
  `conversations.open` semantics — open, don't duplicate — instead of warning about a duplicate.
- **The decisions that shipped**: a person-first wizard with a team mode; open-don't-duplicate on the exact
  effective member set (member-based, never name-based — renamed chats still match); guest and account-less emails
  allowed as members, since they become ACL entries exactly like a share; rooms default into the owner's `chats`
  folder instead of the drive root; the share email is suppressed for chat creation (`suppressShareEmail`) because
  the first message is the real notification; and the contacts entry point prefers the person's registered address
  at click time.
- **Step 1 deliberately mirrors the share dialog.** The design verdict that closed the last round: this is basically
  an ACL screen, so it should work exactly like one — same `ContactAddRow` with the `+` button, suggestions only
  after typing, and the "Team chat" dropdown in the spot where the share dialog puts "Share with team". Consistency
  across the UX beats a bespoke picker.
- **Open residuals**: an account-less member's avatar logs a benign 404 in the wizard; and the legacy `Chats` →
  `chats` rename emits no SSE, so open drive lists and shared-mirror rows keep the old name until a refresh or the
  next rename / ACL touch.

### The two routes

**`GET /chat/:ownerId/rooms/by-members?emails=…`** → `{ matches: ChatMatch[] }`
(`ChatMatch = { path: DrivePath, canWrite }`, `packages/lib/src/types/chat.ts`). Open-don't-duplicate lookup: finds
standalone chats whose current member set exactly equals `{me} ∪ emails`, sorted writable-first then `updatedAt` desc.
`findChatsByMembers` (`apps/api/src/lib/chat/find-by-members.ts`) runs entirely on the caller's Home over
`getMimeTypeContents(DRIVE_MIME_CHAT, {excludeDocumentChildren})` (own mounts + shared-with-me mirror) — no cross-home
calls (SCALABILITY rule).

**`POST /chat/:ownerId/:mountId/rooms {parentId?, fileName, members?, dedupeName?}`** → the created `DrivePath`.
`ownerId` may be the caller (`requireSelf`) or a team (`requireTeamAccess` membership gate on the team home's drive).
Create + share as one server-side sequence: resolve/ensure the `chats` folder when `parentId` is omitted, resolve a free name
via the shared `getUniqueFileName` helper when `dedupeName` is set, `Drive.create(…, 'chat')`, then — personal owners
only — `updateACLDelta` adding `{read, write}` per member with the share email suppressed (see Email suppression);
team owners skip the ACL step entirely (membership is implicit). Members are emails by contract: both routes normalize
(trim + lowercase) and validate them up front (`normalizeMemberEmails`, ≤ 100, real addresses only — owner-shaped ids
like `team_*` are rejected), and an empty/missing `members` on a personal owner is
a 422 — all before anything is created. On ACL failure the fresh container is trashed + purged (best-effort) and the error
rethrown — "a wizard chat is born shared", so a created-but-unshared orphan is worse than a clean error. `dedupeName`
(set by the wizard for auto-generated default names) suffixes a collision server-side (`Name (2)`); a user-typed name
omits it and a duplicate → 409, shown inline.

### Matching semantics

"Same members" = the candidate's **effective member email set** (path ACL + ancestor ACLs + team expansion + owner, all
lowercased) equals `{me} ∪ picked`. "Writable" = I own it, or my ACL entry has `write`. Excluded from matching, because
membership is not a fixed set of people:

- `visibility !== 'private'` (public link = unbounded members),
- any **direct** `team_*` ACL entry (dynamic membership),
- team-owned drives (`ownerId` starts with `team_` = implicit all-team membership).

Own chats are screened by a cheap direct-ACL subset pre-filter before paying for the costly `getEffectiveMembers`
walk. The surviving walks run concurrently and are capped at the `MAX_MEMBER_WALKS = 200` most-recently-updated
candidates — a match past the cap is missed and the wizard offers create instead (accepted caveat). Shared-with-me
candidates skip the walk: the mirror row carries only the direct ACL plus the owner's id, so their set is
`{owner email} ∪ direct ACL emails`.

Two accepted point-in-time caveats (the panel suggests, it never guards): a foreign chat that gains members purely via
a shared parent folder can false-positively match, and a `team_*` entry **inherited from an ancestor folder** is not
excluded — the walk expands it to the team's current members, so an own chat in a team-shared folder matches whenever
that expansion happens to equal the picked set.

### The `chats` folder

`CHATS_FOLDER_NAME = 'chats'` (`packages/lib/src/types/chat.ts`) is the default parent for wizard chats. Seeded by
`Mount.ensureRootFolder` only when it first creates the root, and only for default personal mounts (not team or extra
mounts; the storage backend doesn't matter, so a default S3 mount seeds too). `Drive.ensureChatsFolder(mountId)`
resolves it lazily by name each call (`getChildByName`, which folds case), recreating it on miss (Drive-level create,
so the new root child reaches other tabs via SSE; a concurrent-create 409 adopts the winner's folder) and falling back
to the root if the name is taken by a non-folder — so it stays an ordinary
folder: renameable, movable, deletable, never pinned by id. A legacy auto-created `Chats` folder is renamed in place to
lowercase `chats` on the next resolve (same pathId; the case-folded lookup finds it — see Design decisions for the
accepted no-SSE caveat). English-only product, literal `chats`, no i18n.

### Email suppression

Wizard create shares the new chat with each member but suppresses the "someone shared a file with you" email — a share
email for being added to a chat is wrong-tone and spammy for groups; the first message is the real notification.
`ACLPropagationOptions.suppressShareEmail` (`apps/api/src/lib/drive/acl-propagation.ts`) skips only `composeShareEmail`;
the mirror fan-out, `DRIVE_ACL_SHARED` SSE, and the in-app "X shared a chat" notification still fire. One exception:
an email with no account is only reachable by email, so suppression applies solely to addresses that resolve to a
registered user (guest accounts included) — account-less addresses still get the share email as their invite. Opt-in —
omitting the flag leaves the default share path byte-identical, so `/invite` and the share dialog keep sending the email.

### Team mode

Selecting a team (team selector in the dialog footer, placed like the share dialog's team control) flips the wizard to
team-chat mode: person rows collapse to "Everyone in *<team>* is a member", the name becomes required (a topic, like a
channel), and the location defaults to the team drive's `chats` folder (lazily ensured, same `CHATS_FOLDER_NAME`
mechanics as the personal drive). Instead of the duplicate matcher, the panel lists that team's existing chats (from
the sidebar aggregate, filtered by `ownerId`) with a per-row Open. The footer follows the same open-vs-create rule as
person mode: when any team chat exists the primary "Let's chat" opens the first listed one and "Create new chat" is
the explicit route to the create step. Team chats create through the same **rooms route** with the team `ownerId`
(membership-gated; implicit all-team membership means no ACL step, no share email). The by-members matcher never sees
team-drive chats (excluded above).

### Entry points

- **Chat app**: the sidebar "New chat" button (`apps/chat/src/components/chat/chat-sidebar.tsx`) and the chat empty
  state (`apps/chat/src/routes/_auth.index.tsx`).
- **Drive is intentionally not one**: its `+ New` / context-menu "New chat" creates a plain chat file in the
  browsed folder via the generic `DriveCreateEigenDoc`, exactly like every other eigen type (see the product
  decision at the top of this section). Don't re-wire the wizard into Drive.
- **Contacts**: "Start chat" in `PersonDetailToolbar`
  (`apps/contacts/src/components/contacts/person-detail-toolbar.tsx`), the one toolbar both `contact-detail.tsx` and
  `team-member-detail.tsx` render. Shown for any person with an email address except your own card — an address
  without an account becomes an ACL invite, so there is no registered-user gate. The toolbar calls
  `useStartChatWith(emails)`, which first resolves which of the person's addresses belongs to a registered account
  (batched public-user lookup, misses cached as null) and prefers it over `email[0]`, which can be a later-added
  alias; it then fetches the `{me, them}` match once — exactly one writable match opens directly (cross-app
  `openDocument`, full load), otherwise the caller opens the wizard pre-filled with the chosen address.

## Slash Commands

### Backend (stored as messages)

Parsed by `parseCommand()` in `apps/api/src/lib/chat/commands.ts`. Emote definitions with first/third person text live
in `BUILT_IN_EMOTES` (same file). The emote command list (`EMOTE_COMMANDS`) lives in
`packages/lib/src/core/chat/emotes.ts` and is shared with the frontend for autocomplete.

| Command                                      | Type    | Description                                               |
|----------------------------------------------|---------|-----------------------------------------------------------|
| 80+ built-in emotes (see `emotes.ts`)        | emote   | `/dance`, `/cheer`, `/shrug`, `/flip`, `/trout`, etc.     |
| `/me [action]`                               | emote   | Custom emote                                              |
| `/whisper [email] [msg]` (alias: `/tell`)    | whisper | Private message                                           |

Emotes support optional targets (e.g. `/cheer user@example.com`). Some like `/trout` require a target. The
`canTarget`/`requiresTarget` flags on each `EmoteCommandDef` control this.

Validation: `validateCommand()` in `packages/lib/src/validation/command.ts` validates all commands (shared FE/BE).
Email targets are validated via `validateEmailTarget()`.

### Frontend-only (local system messages)

Handled by `getLocalCommand()` in `packages/lib/src/core/chat/commands.ts`. These never reach the server.

| Command                                 | Description               |
|-----------------------------------------|---------------------------|
| `/help`                                 | Show commands             |
| `/inspect [email]` (`/look`, `/finger`) | User info card            |
| `/invite [email]`                       | Invite user (updates ACL) |
| `/reply [msg]`                          | Reply to last whisper     |

Unknown commands (anything starting with `/` not in the command list) show a local error message.

### Slash Command Autocomplete

Typing `/` opens a suggestion dropdown (`ChatSlashSuggest`). After selecting an emote/whisper/invite command, a target
suggestion dropdown (`ChatPlayerSuggest`) appears showing room members (for emotes/whisper) or contacts (for invite).
The `getSlashTargetQuery()` function in `chat-utils.ts` determines which mode to use.

## @ Mentions

Typing `@` (after whitespace, comma, period, or start of line) opens a player suggestion dropdown. Mid-word `@` (in
emails) does not trigger. Selecting a suggestion inserts the email address.

Mentioned emails are extracted server-side by `extractMentionedEmails()` using `EMAIL_FIND_REGEX`. When a message
contains mentions, the server sends notification center alerts (`mention-chat` for standalone chats, `mention-comment`
for embedded comment chats) to mentioned users who have read access.

## SSE Events

| Event                          | Trigger             | Frontend action          |
|--------------------------------|---------------------|--------------------------|
| `chat:message-posted`          | Message posted      | Invalidate messages      |
| `chat:message-edited`          | Message edited      | Invalidate messages      |
| `chat:message-deleted`         | Message deleted     | Invalidate messages      |
| `chat:comment-index-updated`   | Comment index change| Invalidate comments      |

`ChatRoom.notifySharedUsers()` uses `getEffectiveMembers()` to broadcast events to all users with access (inherited
ACL, team membership, direct ACL). Events are also broadcast to the home that owns the chat.

## Message Pagination

Messages use `useInfiniteQuery` with cursor-based pagination:

- **Page size**: 50 messages
- **Cursor**: `before` param (oldest message ID in current page)
- **Direction**: Newest page first — reversed in `useChatRoom` for chronological display
- **Infinite scroll**: `ChatMessageList` triggers `onLoadMore` when user scrolls within 200px of top
- **Auto-scroll**: Scrolls to bottom on initial load and on new messages (only if within 100px of bottom)

## Message Display

- **Emotes**: Italic with marker. Built-ins show first/second/third person text based on viewer
- **Whispers**: Primary-tinted background (`bg-primary/5`) with "whisper" label. Non-participants see `[a few hushed words]`
- **Deleted**: Content cleared, shown as "This message was deleted."
- **Email rendering**: Emails in content replaced with inline name + hover card (via `usePublicUser`)
- **URL rendering**: URLs auto-linked as clickable links
- **Loading**: `EigenLoader` shown while fetching older messages, `LoadingState` for initial load
- **Grouping**: Consecutive messages from the same author within 5 minutes are grouped (no repeated avatar/name)
- **Attachments**: Shown as chips with thumbnail previews (images) or paperclip icon, clickable to open preview

## Where the code lives

Backend: `apps/api/src/lib/chat/` (`ChatRoom`, schemas + db-config, command parsing, `findChatsByMembers`, the
comment index, SSE builders) and `apps/api/src/routes/chat.ts`. Frontend: `packages/lib/src/core/chat/` (query and
wizard hooks, emotes, FE commands, SSE handler), shared types in `packages/lib/src/types/chat.ts`, shared validation
in `packages/lib/src/validation/command.ts`, and UI in `packages/ui/src/components/layout/chat/` (input, message
list, suggests, `ChatCreateWizard`).

See [COMMENTS.md](COMMENTS.md) for the comment index system.
