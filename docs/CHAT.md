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
Create-chat route lives in Drive router: `apps/api/src/routes/drive.ts`.

```
POST   /drive/:ownerId/:mountId/folder/:pathId/chat                    (create chat — Drive route)
GET    /chat/:ownerId/:mountId/:chatId/messages?before=&limit=
POST   /chat/:ownerId/:mountId/:chatId/messages
PATCH  /chat/:ownerId/:mountId/:chatId/messages/:messageId
DELETE /chat/:ownerId/:mountId/:chatId/messages/:messageId
POST   /chat/:ownerId/:mountId/:chatId/invite
POST   /chat/:ownerId/:mountId/:chatId/read
```

Access control enforced by `getSharedDrive()` (ACL checks). Write routes additionally check `canWrite`.

## ACL

Inherited from Drive. `read` = view messages. `write` = post messages. `owner` = manage ACL.
See [TODO-CHAT-ACL.md](TODO-CHAT-ACL.md) for design discussion.

Chat invites (`/invite` command or `POST .../invite`) bubble ACL to the outermost container document via
`findContainerPath()`. See [ACL.md](ACL.md) for details on invite propagation and `getEffectiveMembers`.

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

## Files

| File                                              | Purpose                                        |
|---------------------------------------------------|------------------------------------------------|
| `apps/api/src/lib/chat/chat.ts`                   | ChatRoom class                                 |
| `apps/api/src/lib/chat/schema.ts`                 | Drizzle schemas (messages + read_state)        |
| `apps/api/src/lib/chat/db-config.ts`              | DB config + migrations                         |
| `apps/api/src/lib/chat/commands.ts`               | Backend command parsing + emote definitions     |
| `apps/api/src/lib/chat/mentions.ts`               | `extractMentionedEmails()` for comment index   |
| `apps/api/src/lib/chat/comment-schema.ts`         | Comment index Drizzle schema                   |
| `apps/api/src/lib/chat/comment-db-config.ts`      | Comment index DB config                        |
| `apps/api/src/lib/chat/comment-index.ts`          | CommentIndex class + helpers                   |
| `apps/api/src/lib/chat/sse-events.ts`             | SSE builders                                   |
| `apps/api/src/routes/chat.ts`                     | API routes                                     |
| `packages/lib/src/types/chat.ts`                  | Shared types (ChatMessage, RoomMember, etc.)   |
| `packages/lib/src/core/chat/emotes.ts`            | `EMOTE_COMMANDS` definitions (shared FE/BE)    |
| `packages/lib/src/core/chat/commands.ts`          | FE command handling, `SLASH_COMMANDS`, help     |
| `packages/lib/src/core/chat/hooks/use-chat.ts`    | Query hooks (messages, post, create, invite)   |
| `packages/lib/src/core/chat/hooks/use-chat-room.ts` | `useChatRoom()` — main room state hook      |
| `packages/lib/src/core/chat/hooks/use-comments.ts`| Comment index hooks                            |
| `packages/lib/src/core/chat/sse-handlers.ts`      | SSE event handler                              |
| `packages/lib/src/validation/command.ts`           | Shared command validation                      |
| `packages/ui/src/components/layout/chat/`          | Shared chat UI (input, message list, suggests) |

See [COMMENTS_IN_DOCS.md](COMMENTS_IN_DOCS.md) for the comment index system.
