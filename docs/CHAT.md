# Chat

> **TLDR:** A chat room is a `.eigenchat` Drive container with its own SQLite `data.db` and a `media/` folder. Messages are append-only rows, not Yjs. Membership is the Drive ACL, and a room stores emails, never user ids. Server code lives in `apps/api/src/lib/chat/` and `apps/api/src/routes/chat.ts`, hooks in `packages/lib/src/core/chat/`, UI in `packages/ui/src/components/chat/`. Not obvious from the code: built-in emotes are stored as keys and phrased per viewer, the server redacts whispers before they leave it, and the new-chat wizard opens an existing chat with the same members instead of creating a duplicate.

## A chat room is a Drive container with its own SQLite database

Each `.eigenchat` is one room: a `data.db` of messages beside a `media/` folder for attachments. Messages are appended, paged and soft-deleted, never merged, so SQLite with an index on `createdAt` fits them better than a Yjs document. Storage, sharing, versioning and trash all come from Drive, so chat adds no infrastructure of its own. The table is in `apps/api/src/lib/chat/schema.ts`.

## A room stores emails, never user ids

Authorship (`authorEmail`) and the whisper target (`whisperTo`) are emails. A chat container is a portable unit that can be copied, restored or moved to another server, and a user id means nothing outside the auth database it came from. Edit and delete ownership and whisper visibility compare the caller's lowercased email against the row. The notification fan-out resolves each email to a user through `getUserByEmail` and skips an email without an account.

## Membership is the Drive ACL

If you can read the room, you are in it: `read` shows the messages and `write` posts, edits and deletes. The `:chatId` routes go through `getSharedDrive()`, and the write routes also check `canWrite`. Edit and delete additionally require that you wrote the message, and answer 404 otherwise.

`/invite` and `POST .../invite` put the new entry on the outermost container document for an embedded chat, because that is where inheritance reads it ([ACL.md § Chat Invite Bubbling](ACL.md#chat-invite-bubbling)).

## A chat inside a document is a comment thread

A document container has a `chat/` folder, and every `.eigenchat` in it is the thread behind one comment card ([COMMENTS.md](COMMENTS.md)). `ChatRoom` finds its container once on init (`findContainerPath`). With a container, every message also updates the container's `comments.db` index, and notifications name the document plus the thread instead of the chat file. Whispers never reach the index.

## Commands split between the server and the client

Commands the server stores as messages are the built-in emotes, `/me` and `/whisper` (alias `/tell`). `parseCommand` (`apps/api/src/lib/chat/commands.ts`) turns them into an `emote` or `whisper` row. `/help`, `/inspect` (`/look`, `/finger`), `/whoami`, `/invite` and `/reply` run in the browser (`getLocalCommand`, `packages/lib/src/core/chat/commands.ts`) and never reach the server; `/invite` calls the invite route. Anything else starting with `/` shows a local error.

Both sides validate with the same `validateCommand` (`packages/lib/src/validation/command.ts`), and the emote list `EMOTE_COMMANDS` (`packages/lib/src/core/chat/emotes.ts`) feeds both the server parser and the autocomplete. An emote's `canTarget` and `requiresTarget` flags decide whether it takes an email.

## Emotes are stored as keys and phrased per viewer

A built-in emote is stored in its wire form, `$dance` or `$dance:marloes@example.com`, not as a sentence. The sentence depends on who reads it: the author sees "You dance with …", the target sees "… dances with you", everyone else the third person. `getMessagesForUser` renders it per viewer with `formatEmoteForViewer`, using the phrases in `BUILT_IN_EMOTES` (`packages/lib/src/core/chat/built-in-emotes.ts`). Notification bodies keep the wire form and render it at display time ([ACTIVITY-ROWS.md](ACTIVITY-ROWS.md#chat-derived-bodies-are-stored-raw-and-rendered-at-display-time)).

## The server redacts whispers

A whisper's target must be a registered user, or the post answers 404. On read, the server rewrites every whisper for the viewer: author and recipient see the text, anyone else gets `[a few hushed words]` with the target kept and the attachments stripped. The browser of a non-participant never holds the text. A whisper also stays out of the comment index and the file history, and notifies only its recipient.

## A message notifies mentions, participants and watchers once each

`ChatRoom.postMessage` resolves the room's effective members once and reuses them:

- Every email in the text is a mention (`extractMentionedEmails`), and a mentioned effective member gets `mention-chat`, or `mention-comment` in a comment thread.
- Everyone who posted before, plus the room's owner, gets `chat-message` or `comment-reply`, unless the mention already covered them. A whisper notifies its recipient only.
- The container (or the standalone room) records a `commented` file event. Its watcher fan-out excludes the author and everyone the two steps above reached, so nobody hears about one message twice ([FILE-HISTORY.md](FILE-HISTORY.md)).

The mention list in the composer opens on `@` only at the start of the text or after whitespace, a comma or a period, so typing an email never triggers it. The tags these notifications carry, and how opening a thread marks them read, are in [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md#chat-and-comment-tags-name-the-thread).

## Every change reaches each effective member over SSE

A post, edit or delete broadcasts a `chat:` event to the home that owns the room and relays it to every effective member (`getEffectiveMembers`, then `relayEventToMembers`). Effective members include people who inherit access from a parent folder and the members of a team entry, who have no direct ACL row on the room. A change in a comment thread also sends `chat:comment-index-updated` for the container. The client handler only invalidates queries ([SSE.md](SSE.md)).

## Messages page backwards from the newest

`useMessages` loads 50 messages per page, newest page first, with the oldest loaded message's id as the `before` cursor, and `useChatRoom` reverses the pages into reading order. The list asks for more when you scroll near the top. It scrolls to a new message only when you were already near the bottom, so reading history is never interrupted.

## A deleted message keeps its row and loses its content

Delete sets `deletedAt`, empties the content and trashes the message's attachments from the room's `media/` folder. The list hides a deleted row entirely, with no tombstone.

## Attachments live in the room's media folder

An attachment is a file name in the room's `media/` folder, or a reference to a drive container. A device file uploads into `media/`. A regular drive file is copied there (`useChatRoom`), because the room's ACL has to cover the file for every member. A container document stays a reference. Comment cards follow the same rule ([COMMENTS.md](COMMENTS.md)).

A chip opens the file's actions from the shared chip menu ([PREVIEWS.md § One hook wires every attachment chip to the menu](PREVIEWS.md#one-hook-wires-every-attachment-chip-to-the-menu)), and "Save attachments" copies the files into Drive server-side through `SaveToDrivePicker`, with "Download instead" as the escape hatch.

## The new-chat wizard opens an existing chat before it creates one

`ChatCreateWizard` (`packages/ui/src/components/chat/chat-create-wizard.tsx`) is a two-step dialog. Step 1 picks people or a team. If a chat with exactly that membership exists, the primary button opens it and "Create new chat" moves on. Step 2 confirms the name and the location. The chat sidebar's "New chat" button, the chat app's empty state and the contacts menu open it. Guests never see it (`useIsGuest`): they can't share, so it could never succeed, and the create route rejects them too (`requireNonGuest`).

### A chat is a file, so the wizard hides as much file-ness as it can

Signal, WhatsApp, Telegram, Slack and Google Chat are all person-first: the new-chat action is a picker, with no name step, no location step, and no way to create a second 1:1. An Eigen chat is a file with a name and a place in Drive, so it sits closer to a Slack channel and can never be fully person-first. The wizard shows as little file-ness as possible at creation time and copies Slack's `conversations.open`: open the existing chat instead of warning about a duplicate.

What follows from that:

- Matching is on the exact effective member set, never on the name, so a renamed chat still matches.
- Guest and account-less emails are allowed as members, because they become ACL entries exactly like a share.
- New chats default into the owner's `chats` folder, not the drive root.
- Being added to a chat sends no share email.
- The contacts entry prefers the person's registered address.

### Drive creates a plain chat file, never the wizard

Drive is a place-first surface. Its "New" menu, list context menu and mobile toolbar create a chat like any other Eigen type (`DriveCreateEigenDoc type="chat"`) in the folder you are browsing. The new chat starts with exactly the members its location's ACL implies, which keeps the file model visible. The wizard, with its open-don't-duplicate rule and its `chats` default, belongs to the person-first surfaces, where the intent is "talk to someone", not "create a file here". So Drive has no path into the wizard: its open-don't-duplicate rule would answer a create in this folder with a chat that lives somewhere else.

### Step 1 works like the share dialog

Adding members is an ACL edit, so step 1 uses the share dialog's `ContactAddRow` with its `+` button, shows suggestions only after typing, and puts the "Team chat" dropdown where the share dialog puts "Share with team". Consistency across the product beats a bespoke picker.

### Matching compares effective member sets

`GET /chat/:ownerId/rooms/by-members?emails=…` returns the standalone chats whose members are exactly `{me} ∪ emails`, writable first, then most recently updated. "Writable" means I own it or my ACL entry has `write`. `findChatsByMembers` (`apps/api/src/lib/chat/find-by-members.ts`) reads only the caller's own home: their mounts plus the shared-with-me mirror. It makes no cross-home calls ([SCALABILITY.md](SCALABILITY.md)), which is why the route is self-only.

A chat's members are its effective member emails: path ACL, ancestor ACLs, expanded teams and the owner, all lowercased. A chat whose membership is not a fixed set of people never matches:

- a public link (`visibility !== 'private'`), since anyone with the link is a member
- a direct `team_*` ACL entry, since team membership changes
- a chat on a team drive, since every team member is implicitly in it

Own chats pass a cheap direct-ACL subset screen before the costly `getEffectiveMembers` walk. The walks run concurrently and stop at the `MAX_MEMBER_WALKS` most recently updated candidates, so a match past the cap is missed and the wizard offers create instead. A shared-with-me chat skips the walk: its mirror row has only the direct ACL and the owner, so its set is the owner's email plus the direct entries.

The panel suggests; it never guards. Two point-in-time misses are accepted:

- A foreign chat that gains members through a shared parent folder can match falsely, since the mirror row doesn't see the parent.
- A `team_*` entry inherited from an ancestor folder is not excluded. The walk expands it to the team's current members, so an own chat in a team-shared folder matches whenever that expansion equals the picked set.

### Create and share are one server-side step

`POST /chat/:ownerId/:mountId/rooms {parentId?, fileName, members?, dedupeName?}` creates the chat and shares it with `{read, write}` per member in one request, then returns the `DrivePath`. Members are emails by contract: both wizard routes trim, lowercase and validate them first (`normalizeMemberEmails`), and reject owner-shaped ids like `team_*`. A personal chat without members is a 422, before anything is created.

A wizard chat is born shared. If the ACL step fails, the route trashes and purges the fresh container and rethrows, because a created-but-unshared chat is worse than a clean error. `dedupeName` is set for the wizard's generated default names and suffixes a collision (`Name (2)`). A name the user typed omits it, and a duplicate is a 409 shown inline.

### Wizard chats land in a `chats` folder resolved by name

`CHATS_FOLDER_NAME` (`packages/lib/src/types/chat.ts`) is the default parent. `Mount.ensureRootFolder` seeds it only on a default personal mount, when it first creates the root. `Drive.ensureChatsFolder` finds it by name on every use (`getChildByName` folds case) and recreates it when it is missing, so it stays an ordinary folder that you can rename, move or delete, never pinned by id. A concurrent create's 409 adopts the winner's folder, and a non-folder with that name makes the chat land in the root. A legacy `Chats` folder is renamed to `chats` in place on the next resolve.

### Adding someone to a chat sends no share email

A "someone shared a file with you" email for being added to a chat has the wrong tone and spams groups; the first message is the real notification. The create route passes `suppressShareEmail: 'registered'`, which skips only the email ([ACL.md § Share Emails](ACL.md#share-emails)). The mirror fan-out, the `drive:acl-shared` event and the in-app share notification still happen. An address without an account still gets the email, because it is that person's only invite. `/invite` and the share dialog don't pass the flag and keep sending it.

### A team chat takes its members from the team

Picking a team in the footer switches the wizard to team mode. The people rows collapse to "Everyone in <team> is a member", the name becomes required (a topic, like a channel), and the location defaults to the team drive's `chats` folder. Instead of the member matcher, the panel lists the team's existing chats from the sidebar aggregate, and the primary button opens the first one, as in person mode. The create goes through the same rooms route with the team's `ownerId`, gated by `requireTeamAccess`. It skips the ACL step and so sends no share email, because team membership is implicit.

### Contacts open an existing chat directly

"Start chat" in the contacts menu (`apps/contacts/src/components/contacts/contact-menu.tsx`, shared by the list's context menu and the detail toolbar) shows for any selected person with an email except yourself. An address without an account becomes an ACL invite, so there is no registered-user gate. For one person, `useStartChatWith` first finds which of their addresses belongs to an account and prefers it, because the first address can be a later-added alias and the match is keyed by the account address. Exactly one writable match opens directly. Otherwise, and for several people, the wizard opens pre-filled.

## See also

- [ACL.md](ACL.md): inheritance, invite bubbling and share emails
- [COMMENTS.md](COMMENTS.md): the card and index behind an embedded chat
- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) and [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md): where chat notifications land and how they read
- [FILE-HISTORY.md](FILE-HISTORY.md): the `commented` event and watches
- [PREVIEWS.md](PREVIEWS.md): the attachment chip menu
