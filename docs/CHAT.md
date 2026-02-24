# Chat System

Chat is a Drive document type (`application/eigenchat`), like `.eigendoc` and `.eigenstickies`. A chat contains room folders (`application/eigenchatroom`), each with its own SQLite database. ACL, storage, and sharing are all inherited from Drive.

**Why not Yjs?** Chat is append-only messages, not collaborative editing. SQLite gives pagination, indexing, and efficient queries. Yjs documents grow forever and can't be paginated.

---

## 1. Design Philosophy

MUD-inspired, adapted to Eigen's architecture:

- **Room-based**: You are "in" a room. Presence is visible. Entering/leaving is an event
- **Focus-first**: Notifications scoped to active room (with @mention exceptions)
- **Commands**: `/me` emotes, `/whisper` private messages
- **Keyboard-first**: Command-driven interaction
- Rooms are Drive folders → ACL works automatically
- Real-time via SSE (existing) → no new infrastructure
- History is paginated SQLite → efficient at any scale

---

## 2. Storage Architecture

### MIME Types

| Type | MIME | Extension |
|------|------|-----------|
| Chat | `application/eigenchat` | `.eigenchat` |
| Room | `application/eigenchatroom` | `.eigenchatroom` |

These extend the existing type system in `packages/lib/src/types/drive.ts`. Chat/chatroom are **not** collab types (not Yjs-based), so they don't join `DriveCollabType`. Instead, add a new `DriveChatType = "chat" | "chatroom"` and extend `DriveContainerType` to include it. Update `isContainerType()` accordingly. `mount.ts` `createFolder()` maps them to MIME types (same pattern as `doc` → `application/eigendoc`).

### Standalone Chat

```
my-team-chat.eigenchat/              (type: chat)
├── general.eigenchatroom/           (type: chatroom, name = "general")
│   ├── data.db                      (messages + read state)
│   ├── screenshot.png               (uploaded attachment)
│   └── report.pdf                   (uploaded attachment)
├── random.eigenchatroom/
│   └── data.db
└── dev.eigenchatroom/
    └── data.db
```

**Room name = folder name.** Renaming a room is a Drive rename operation. No separate metadata needed.

Uploaded files (attachments) are children of the room folder, alongside `data.db`. The client resolves media URLs through standard Drive file endpoints.

### Embedded Chat (Docs & Stickies)

**Auto-created** when a doc or stickies is created — `createDoc()` and `createStickies()` in `drive.ts` create a `comments.eigenchat` child with a default `general.eigenchatroom`:

```
my-document.eigendoc/
├── data.db                          (Yjs document data)
└── comments.eigenchat/
    └── general.eigenchatroom/
        └── data.db
```

The embedded chat inherits ACL from the parent document. No backwards compatibility needed — existing data can be recreated.

The collab info endpoint (`GET /collab/:ownerId/:mountId/:pathId/info`) already returns `folderContents`, which includes the `comments.eigenchat` child. No separate endpoint needed — the client uses the chat pathId from folder contents to access chat routes.

### System Chat Folder

Each user gets an `eigen.chat/` folder in Drive (a metadata.db entry in the default mount, same as how docs/stickies are stored). Created on first use when the chat app opens. Users can also create `.eigenchat` documents anywhere in Drive.

---

## 3. Database Schema

Each `.eigenchatroom` contains a `data.db` (same naming as eigendoc/eigenstickies) with two tables.

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

System messages (`type: system`) are used for enter/leave events, stored in the same table for a unified history.

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

### No settings table

Room metadata comes from Drive: name (folder name), creator (folder owner), created at (folder timestamp), ACL (folder ACL). Room type is derived from context — embedded in a doc? It's a comment room. ACL restricted to two users? It's a DM. No separate settings table needed.

---

## 4. Presence

Presence is tracked via **heartbeat polling**, not explicit enter/leave calls.

1. Client sends `POST /chat/:ownerId/:mountId/:roomId/heartbeat` every **30 seconds** while a room is open
2. The `ChatRoom` object tracks `activeUsers: Map<userId, lastHeartbeat>` **in memory only**
3. When a heartbeat arrives for a user not previously active → **enter** (system message in `data.db` + SSE)
4. Background check every 60s: if `lastHeartbeat > 2 min ago` → **leave** (system message + SSE + remove from map)

This handles browser closes and disconnects naturally — heartbeats stop, timeout fires, leave event emitted. No state to clean up on disconnect.

The `ChatRoom` object auto-destructs when no users are active (same pattern as Home's 5-minute timeout), closing its `data.db` connection.

---

## 5. API Design

### Room Management

Room CRUD uses **existing Drive operations** — no special chat endpoints needed:

- **Create room**: Drive `createFolder` with type `chatroom` under the `.eigenchat` parent
- **List rooms**: Drive `getFolderContents` on the `.eigenchat` folder (filter by `chatroom` type)
- **Rename room**: Drive rename (folder name = room name)
- **Delete room**: Drive delete

### Chat Routes

New router: `apps/api/src/routes/chat.ts`, prefix `/chat/`, all `auth: true`.

The `roomId` is the Drive pathId of the `.eigenchatroom` folder. ACL is checked via `drive.canRead()`/`canWrite()`.

```
GET    /chat/:ownerId/:mountId/:roomId/messages?before=&limit=
POST   /chat/:ownerId/:mountId/:roomId/messages
PATCH  /chat/:ownerId/:mountId/:roomId/messages/:messageId
DELETE /chat/:ownerId/:mountId/:roomId/messages/:messageId
POST   /chat/:ownerId/:mountId/:roomId/read
POST   /chat/:ownerId/:mountId/:roomId/heartbeat
POST   /chat/:ownerId/:mountId/:roomId/typing
POST   /chat/:ownerId/:mountId/:roomId/upload
```

**Message pagination**: Cursor-based with `?before={messageId}&limit=50`. Initial load returns most recent messages. Client scrolls up to load older.

### Backend Class

```
apps/api/src/lib/chat/
├── chat.ts       # ChatRoom class (per room, manages data.db + presence)
├── schema.ts     # Drizzle schemas (messages, read_state)
├── db-config.ts  # ROOM_DB_CONFIG + migrations
├── sse-events.ts # SSE event builders
└── index.ts
```

`ChatRoom` is instantiated per room (similar to `CollabDocument`). It manages `data.db`, tracks active users via heartbeats, and auto-destructs when idle.

---

## 6. Real-Time (SSE)

Uses the existing SSE system. New event types in `packages/lib/src/types/sse.ts`:

```
chat:message_posted
chat:message_edited
chat:message_deleted
chat:member_entered
chat:member_left
chat:typing
```

**Cross-user notification** follows the ACL propagation pattern: resolve all users with ACL access to the room, then notify those who have an active Home instance (online users). This ensures offline users get unread counts on next load, while online users get real-time SSE delivery. For the monolith with <100 concurrent users, iterating ACL entries is sufficient.

**Typing indicators** are fire-and-forget — no persistence. Client debounces (max once per 2s). Server broadcasts `chat:typing` SSE to other members.

**@mentions**: When a message contains `@email`, the server sends a targeted SSE notification to that user's Home regardless of their active room. The client shows a badge + optional toast.

---

## 7. ACL & Permissions

Inherits from Drive's ACL system — no new permission logic.

| Drive ACL | Chat Permission |
|-----------|----------------|
| `read: true` | Read messages, see members |
| `write: true` | Post messages, upload media |
| `owner` | Create/delete rooms, manage ACL |

- **Share entire chat**: Set ACL on `.eigenchat` folder → access to all rooms
- **Share single room**: Set ACL on `.eigenchatroom` folder → access to that room only
- **Embedded chat**: Inherits from parent `.eigendoc` / `.eigenstickies`
- **DM rooms**: Rooms with ACL restricted to two users (no special type field)

---

## 8. Frontend Architecture

### Standalone App

```
apps/chat/src/
├── components/chat/
│   ├── room-list.tsx           # Sidebar: rooms with unread badges
│   ├── room-detail.tsx         # Message stream + input
│   ├── message-list.tsx        # Paginated messages (useInfiniteQuery)
│   ├── message-input.tsx       # Input with /commands + file upload
│   ├── message-item.tsx        # Single message with reply
│   ├── member-list.tsx         # Room members with presence
│   └── typing-indicator.tsx
├── routes/
└── main.tsx
```

### Shared Components (for embedding in Docs/Stickies)

```
packages/ui/src/components/layout/chat/
├── chat-panel.tsx              # Self-contained panel (rooms + messages)
├── chat-input.tsx              # Message input
└── chat-message.tsx            # Message rendering
```

Accept a `chatPath` prop (Drive path to `.eigenchat`) and handle everything internally.

### Hooks

```
packages/lib/src/lib/chat/
├── hooks/
│   ├── use-rooms.ts            # Room listing
│   ├── use-messages.ts         # Messages (infinite scroll)
│   └── use-presence.ts         # Heartbeat + active users
├── sse-handlers.ts
└── index.ts
```

---

## 9. Implementation

### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/chat/chat.ts` | ChatRoom class |
| `apps/api/src/lib/chat/schema.ts` | Drizzle schemas (messages, read_state) |
| `apps/api/src/lib/chat/db-config.ts` | Database config + migrations |
| `apps/api/src/lib/chat/sse-events.ts` | SSE event builders |
| `apps/api/src/routes/chat.ts` | Chat API routes |
| `packages/lib/src/types/chat.ts` | Chat types |
| `packages/lib/src/lib/chat/` | Hooks + SSE handlers |
| `packages/ui/src/components/layout/chat/` | Shared chat components |
| `apps/chat/` | Standalone chat app |

### Modified Files

| File | Change |
|------|--------|
| `packages/lib/src/types/drive.ts` | Add `chat`/`chatroom` to type unions, `isContainerType` |
| `packages/lib/src/types/sse.ts` | Add `chat:` event types |
| `packages/lib/src/lib/sse/hooks/use-sse.ts` | Register chat SSE handler |
| `apps/api/src/lib/mount/mount.ts` | `createFolder()` supports `chat`/`chatroom` types → MIME mapping |
| `apps/api/src/lib/mount/schema.ts` | Add `chat`/`chatroom` to paths type union |
| `apps/api/src/lib/drive/drive.ts` | Add `createChat()`, `createChatRoom()`. Modify `createDoc()`/`createStickies()` to auto-create embedded chat |
| `packages/ui/.../file-icon-helper.tsx` | Icons for `.eigenchat` / `.eigenchatroom` |

### Phases

1. **Core**: MIME types in Drive type system, ChatRoom class, schema, API routes, SSE events
2. **Standalone app**: `apps/chat/` — room list, messages, presence, /commands
3. **Embedding**: Auto-create in docs/stickies, shared components, chat panel in editors
4. **Polish**: @mentions, search, message pinning
