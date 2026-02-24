# Chat System

A chat is a Drive document type (`application/eigenchat`), like `.eigendoc` and `.eigenstickies`. **A chat IS a room** — each `.eigenchat` has its own SQLite database and media folder. No nesting of rooms inside chats. ACL, storage, and sharing are all inherited from Drive.

**Why not Yjs?** Chat is append-only messages, not collaborative editing. SQLite gives pagination, indexing, and efficient queries. Yjs documents grow forever and can't be paginated.

---

## 1. Design Philosophy

MUD-inspired, adapted to Eigen's architecture:

- **Chat = Room**: Each `.eigenchat` is a single chat room with its own `data.db`
- **Focus-first**: Notifications scoped to active chat (with @mention exceptions)
- **Commands**: MUD-style slash commands (emotes, whisper, inspect, invite)
- **Keyboard-first**: Command-driven interaction
- **Validation**: Both client and server validate commands and targets
- Chats are Drive folders → ACL works automatically
- Real-time via SSE (existing) → no new infrastructure
- History is paginated SQLite → efficient at any scale

---

## 2. Storage Architecture

### MIME Type

| Type | MIME | Extension |
|------|------|-----------|
| Chat | `application/eigenchat` | `.eigenchat` |

Extends `packages/lib/src/types/drive.ts` with `DriveChatType = "chat"` added to `DriveContainerType`. `mount.ts` `createFolder()` maps `chat` → `application/eigenchat`.

### Standalone Chat

```
my-team-chat.eigenchat/              (type: chat)
├── data.db                          (messages + read state)
└── media/                           (uploaded attachments)
    ├── screenshot.png
    └── report.pdf
```

**Chat name = folder name.** Renaming is a Drive rename operation. `ChatRoom.create()` creates both `data.db` and a `media/` subfolder.

### Embedded Chat (Docs & Stickies)

When a doc or stickies is created, `createDoc()`/`createStickies()` in `drive.ts` also create a `chat/` subfolder with a default "General" chat:

```
my-document.eigendoc/
├── data.db                          (Yjs document data)
├── media/                           (doc media)
└── chat/                            (chat subfolder)
    └── General.eigenchat/
        ├── data.db
        └── media/
```

The embedded chats inherit ACL from the parent document. The collab info endpoint returns `folderContents` which includes the `chat/` subfolder. Users can create additional chats in the `chat/` subfolder.

---

## 3. Database Schema

Each `.eigenchat` contains a `data.db` with two tables.

### messages

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `authorId` | TEXT | User ID |
| `authorEmail` | TEXT | For display |
| `type` | TEXT | `message` / `emote` / `whisper` / `system` |
| `content` | TEXT | Markdown text |
| `attachments` | TEXT | JSON array of pathIds (nullable) |
| `whisperTo` | TEXT | User ID (whisper type only) |
| `replyTo` | TEXT | Message ID for threaded replies |
| `editedAt` | INTEGER | NULL if not edited |
| `deletedAt` | INTEGER | Soft delete |
| `createdAt` | INTEGER | Timestamp |

### read_state

| Column | Type | Description |
|--------|------|-------------|
| `userId` | TEXT PK | User ID |
| `lastReadMessageId` | TEXT | Last read message ID |
| `lastReadAt` | INTEGER | Timestamp |

### Indexes

- `messages(createdAt)` — cursor-based pagination
- `messages(replyTo)` — thread queries
- `messages(authorId)` — author filter

---

## 4. API Design

### Chat Creation (Drive route)

```
POST /drive/:ownerId/:mountId/folder/:pathId/chat   {fileName: string}
```

Creates an `.eigenchat` folder with `data.db` and `media/` subfolder.

### Chat Routes

Router: `apps/api/src/routes/chat.ts`, prefix `/chat/`, all `auth: true`. The `chatId` is the Drive pathId of the `.eigenchat` folder.

```
GET    /chat/:ownerId/:mountId/:chatId/messages?before=&limit=
POST   /chat/:ownerId/:mountId/:chatId/messages
PATCH  /chat/:ownerId/:mountId/:chatId/messages/:messageId
DELETE /chat/:ownerId/:mountId/:chatId/messages/:messageId
POST   /chat/:ownerId/:mountId/:chatId/read
```

### Backend Class

```
apps/api/src/lib/chat/
├── chat.ts       # ChatRoom class (per chat, manages data.db)
├── schema.ts     # Drizzle schemas (messages, read_state)
├── db-config.ts  # CHAT_DB_CONFIG + migrations
├── sse-events.ts # SSE event builders
└── index.ts
```

---

## 5. ACL & Permissions

Inherits from Drive's ACL system — no new permission logic.

| Drive ACL | Chat Permission |
|-----------|----------------|
| `read: true` | Read messages, see members |
| `write: true` | Post messages, upload media |
| `read: true, write: false` | Read-only — can view but not post, edit, or delete |
| `owner` | Manage ACL |

- **Share chat**: Set ACL on `.eigenchat` folder
- **Embedded chat**: Inherits from parent `.eigendoc` / `.eigenstickies`
- **DM**: Chat with ACL restricted to two users
- **Write enforcement**: POST/PATCH/DELETE routes check `canWrite()` and return 403 if read-only
- **Frontend**: `MessageInput` shows read-only notice when user lacks write permission

---

## 6. Frontend Architecture

### Standalone App (`apps/chat/`)

Two-column layout: sidebar (my chats + shared with me) and messages.

```
apps/chat/src/
├── components/chat/
│   ├── chat-sidebar.tsx        # My chats + shared with me
│   ├── message-list.tsx        # Messages display
│   └── message-input.tsx       # Input with send button
├── routes/
│   ├── __root.tsx
│   ├── login.tsx
│   ├── _auth.tsx
│   ├── _auth.index.tsx         # Empty state / create first chat
│   └── _auth.$ownerId.$mountId.$chatId.tsx
└── main.tsx
```

### Hooks (`packages/lib/src/lib/chat/`)

- `useChats(ownerId, mountId)` — own + shared chats (filtered by `application/eigenchat`)
- `useMessages(ownerId, mountId, chatId)` — GET messages with polling
- `usePostMessage(ownerId, mountId, chatId)` — POST message mutation
- `useCreateChat(ownerId, mountId)` — create chat via drive

---

## 7. Implementation Status

### Implemented

| File | Purpose |
|------|----------|
| `apps/api/src/lib/chat/chat.ts` | ChatRoom class (messages, read state, whisper filtering) |
| `apps/api/src/lib/chat/schema.ts` | Drizzle schemas (messages, read_state) |
| `apps/api/src/lib/chat/db-config.ts` | Database config + migrations |
| `apps/api/src/lib/chat/sse-events.ts` | SSE event builders |
| `apps/api/src/routes/chat.ts` | Chat API routes (messages, read) |
| `packages/lib/src/types/chat.ts` | Chat types (ChatMessage, ChatReadState) |
| `packages/lib/src/types/drive.ts` | `DriveChatType`, `isChatType()`, updated `DriveContainerType` |
| `packages/lib/src/types/sse.ts` | Chat SSE event types |
| `apps/api/src/lib/drive/drive.ts` | `createChat()`, `getChat()`, chat/ subfolder in createDoc/createStickies |
| `apps/api/src/lib/drive/sharedDrive.ts` | Delegated `createChat()`, `getChat()` |
| `apps/api/src/routes/drive.ts` | `POST .../folder/:pathId/chat` route |
| `apps/api/src/test/chat.test.ts` | Tests: creation, messages, whisper visibility (3 users) |
| `apps/chat/` | Standalone chat app (PoC) |
| `packages/lib/src/lib/chat/` | FE hooks (useChats, useMessages, usePostMessage, useCreateChat) |

## 8. Slash Commands

Parsed on backend (`apps/api/src/lib/chat/commands.ts`) and locally on frontend (`apps/chat/src/lib/commands.ts`).

### Backend Commands (stored as messages)

| Command | Aliases | Type | Description |
|---------|---------|------|-------------|
| `/dance` | — | emote | Built-in dance emote |
| `/cheer` | — | emote | Built-in cheer emote |
| `/taunt` | — | emote | Built-in taunt emote |
| `/greet` | — | emote | Built-in greet emote |
| `/allthethings` | — | emote | ALL THE THINGS! |
| `/facepalm` | — | emote | Facepalm emote |
| `/shrug` | — | emote | Shrug with kaomoji |
| `/flip` | — | emote | Table flip |
| `/me [action]` | — | emote | Custom emote |
| `/whisper [email] [msg]` | `/w`, `/tell`, `/t`, `/send` | whisper | Private message |

### Frontend-Only Commands (local system messages)

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/?`, `/h` | Show available commands |
| `/time` | — | Show local and server time |
| `/inspect [email]` | `/look`, `/finger` | Show user info card |
| `/invite [email]` | `/i`, `/inv` | Invite user to room (updates ACL) |
| `/reply [msg]` | `/r` | Reply to last whisper |

### Validation

- **Unknown commands**: Client-side check prevents sending messages starting with `/` that don't match known commands
- **Whisper targets**: Must be valid email addresses (validated both client and server). Server returns 400 for non-email targets, 404 for non-existent users
- **Invite targets**: Must be valid email addresses (client-side validation)

## 9. Message Display

- **Emotes**: Shown with ✦ marker, italic text. Built-in emotes show first/third person text
- **Whispers**: Orange background, "whisper" badge. Author sees "whispers to X", recipient sees "whispers to you", others see "[a few hushed words]"
- **Email rendering**: Email addresses in message content are replaced with inline avatar + name (clickable, opens mail compose)
- **Inspect card**: Shows user avatar, name, email (clickable), company/job, phone from public user data and contacts
- **Deleted messages**: Content cleared to `''` in database, displayed as "This message was deleted"

## 10. @ Mention Trigger

Typing `@` after whitespace, comma, dot, or at start of line opens a player suggestion dropdown. Selecting a suggestion replaces from the `@` to cursor with the selected email. Mid-word `@` (e.g., in email addresses) does not trigger the dropdown.

---

## 11. Remaining

| Phase | Scope |
|-------|-------|
| **Presence** | Heartbeat endpoint, in-memory tracking, enter/leave system messages |
| **Embedding UI** | Chat panel in docs/stickies editors |
| **Polish** | @mentions (full), search, infinite scroll, typing indicators |
