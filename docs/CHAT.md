# Chat System

> **TLDR**: Chat rooms are `.eigenchat` Drive folders with own `data.db` (SQLite) + `media/`. Not Yjs — append-only
> messages use SQLite for pagination/indexing. ACL inherited from Drive. Slash commands include emotes, whisper, invite.
> Embedded chats auto-created inside docs/stickies.

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
| `authorEmail` | TEXT    | Display name                               |
| `type`        | TEXT    | `message` / `emote` / `whisper` / `system` |
| `content`     | TEXT    | Markdown                                   |
| `attachments` | TEXT    | JSON array of file names                   |
| `whisperTo`   | TEXT    | User ID (whisper only)                     |
| `replyTo`     | TEXT    | Message ID (threaded replies)              |
| `editedAt`    | INTEGER | Null if not edited                         |
| `deletedAt`   | INTEGER | Soft delete                                |
| `createdAt`   | INTEGER | Timestamp                                  |

### read_state

| Column              | Type    | Description       |
|---------------------|---------|-------------------|
| `userId`            | TEXT PK | User ID           |
| `lastReadMessageId` | TEXT    | Last read message |
| `lastReadAt`        | INTEGER | Timestamp         |

## API Routes

Router: `apps/api/src/routes/chat.ts`, prefix `/chat/`, all `{auth: true}`.

```
POST   /drive/:ownerId/:mountId/folder/:pathId/chat   (create chat — Drive route)
GET    /chat/:ownerId/:mountId/:chatId/messages?before=&limit=
POST   /chat/:ownerId/:mountId/:chatId/messages
PATCH  /chat/:ownerId/:mountId/:chatId/messages/:messageId
DELETE /chat/:ownerId/:mountId/:chatId/messages/:messageId
POST   /chat/:ownerId/:mountId/:chatId/read
```

## ACL

Inherited from Drive. `read` = view messages. `write` = post messages. `owner` = manage ACL.
See [TODO-CHAT-ACL.md](TODO-CHAT-ACL.md) for design discussion.

## Slash Commands

### Backend (stored as messages)

| Command                                                                                 | Type    | Description     |
|-----------------------------------------------------------------------------------------|---------|-----------------|
| `/dance`, `/cheer`, `/taunt`, `/greet`, `/allthethings`, `/facepalm`, `/shrug`, `/flip` | emote   | Built-in emotes |
| `/me [action]`                                                                          | emote   | Custom emote    |
| `/trout [email]`                                                                        | emote   | Targeted emote  |
| `/whisper [email] [msg]` (aliases: `/w`, `/tell`, `/t`, `/send`)                        | whisper | Private message |

### Frontend-only (local system messages)

| Command                                 | Description               |
|-----------------------------------------|---------------------------|
| `/help` (`/?`, `/h`)                    | Show commands             |
| `/time`                                 | Show time                 |
| `/inspect [email]` (`/look`, `/finger`) | User info card            |
| `/invite [email]` (`/i`, `/inv`)        | Invite user (updates ACL) |
| `/reply [msg]` (`/r`)                   | Reply to last whisper     |

## @ Mentions

Typing `@` (after whitespace/start of line) opens player suggestion dropdown. Mid-word `@` (in emails) does not trigger.

## Message Pagination

Messages use `useInfiniteQuery` with cursor-based pagination:

- **Page size**: 50 messages
- **Cursor**: `before` param (oldest message ID in current page)
- **Direction**: Newest page first — reversed in `useChatRoom` for chronological display
- **Infinite scroll**: `ChatMessageList` triggers `onLoadMore` when user scrolls within 200px of top
- **Auto-scroll**: Scrolls to bottom on initial load and on new messages (only if already near bottom)

## Message Display

- **Emotes**: Italic with marker. Built-ins show first/third person text
- **Whispers**: Primary-tinted background with "whisper" label
- **Deleted**: Content cleared, shown as "This message was deleted"
- **Email rendering**: Emails in content replaced with inline avatar + name
- **Loading**: `EigenLoader` shown during initial load and while fetching older messages
- **Grouping**: Consecutive messages from the same author within 5 minutes are grouped (no repeated avatar/name)

## Files

| File                                         | Purpose                                      |
|----------------------------------------------|----------------------------------------------|
| `apps/api/src/lib/chat/chat.ts`              | ChatRoom class                               |
| `apps/api/src/lib/chat/schema.ts`            | Drizzle schemas (messages + read_state)      |
| `apps/api/src/lib/chat/db-config.ts`         | DB config + migrations                       |
| `apps/api/src/lib/chat/commands.ts`          | Backend slash commands                       |
| `apps/api/src/lib/chat/mentions.ts`          | `extractMentionedEmails()` for comment index |
| `apps/api/src/lib/chat/comment-schema.ts`    | Comment index Drizzle schema                 |
| `apps/api/src/lib/chat/comment-db-config.ts` | Comment index DB config                      |
| `apps/api/src/lib/chat/comment-index.ts`     | CommentIndex class + helpers                 |
| `apps/api/src/lib/chat/sse-events.ts`        | SSE builders                                 |
| `apps/api/src/routes/chat.ts`                | API routes                                   |
| `packages/lib/src/types/chat.ts`             | Shared types                                 |
| `packages/lib/src/core/chat/`                | FE hooks + SSE handlers                      |
| `packages/ui/src/components/layout/chat/`    | Shared chat UI components                    |

See [COMMENTS_IN_DOCS.md](COMMENTS_IN_DOCS.md) for the comment index system.
