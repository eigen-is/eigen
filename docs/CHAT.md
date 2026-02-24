# Chat System

Proposal for a unified messaging system that powers standalone chat rooms, document comments, and stickies board discussions — all built on Drive's existing storage and ACL infrastructure.

## Table of Contents

1. [Overview](#1-overview)
2. [Design Philosophy](#2-design-philosophy)
3. [Storage Architecture](#3-storage-architecture)
4. [Database Schemas](#4-database-schemas)
5. [API Design](#5-api-design)
6. [Real-Time Notifications](#6-real-time-notifications)
7. [ACL & Permissions](#7-acl--permissions)
8. [Embedded Chat (Docs & Stickies)](#8-embedded-chat-docs--stickies)
9. [Media & Attachments](#9-media--attachments)
10. [Pagination & Performance](#10-pagination--performance)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Migration & Rollout](#12-migration--rollout)
13. [Open Questions](#13-open-questions)
14. [Honest Analysis](#14-honest-analysis)

---

## 1. Overview

Chat in Eigen is **not a separate service** — it is a Drive document type, just like `.eigendoc` and `.eigenstickies`. A chat instance is a folder on Drive containing room subfolders, where each room is fully self-contained with its own SQLite database and media folder.

This means:

- **ACL is inherited from Drive** — sharing a chat or a room works exactly like sharing a folder
- **Chat can be embedded** — adding a `.eigenchat` folder inside a `.eigendoc` or `.eigenstickies` folder gives that document a comments/discussion panel
- **Storage accounting works** — chat data counts toward user storage quotas via the existing mount system
- **No new infrastructure** — no WebSocket server, no Redis, no message broker. SSE handles real-time delivery, SQLite handles persistence

### Chat vs. Yjs

We deliberately avoid Yjs for chat. Yjs is optimized for concurrent document editing (CRDTs), not append-only message streams. Using Yjs for chat would mean:

- Ever-growing Yjs documents that cannot be paginated
- No efficient "load last 50 messages" — you'd need the full doc
- Merge conflicts on metadata (read receipts, reactions) that don't benefit from CRDTs
- Memory pressure from materializing large chat histories

Instead, messages are rows in SQLite — append-only, indexable, paginated, and cheap.

---

## 2. Design Philosophy

Inspired by the MUD-based chat concept from `apps/chat/README.md`:

- **Room-based**: You are "in" a room. Presence is visible. Entering/leaving is an event.
- **Focus-first**: Notifications scoped to your active room (with @mention exceptions).
- **Peek**: Preview a room without entering (no presence event triggered).
- **Actions**: `/me` emotes for expressive communication.
- **Whispers**: Private inline messages within a room.
- **Keyboard-first**: Command-driven interaction (`/go`, `/me`, `/whisper`).

But adapted to Eigen's architecture:

- Rooms are folders on Drive, not abstract channel objects
- Access control uses Drive ACL, not a separate permission system
- Real-time uses SSE (existing), not WebSockets (new infrastructure)
- History is paginated SQLite queries, not full-doc sync

---

## 3. Storage Architecture

### 3.1 Standalone Chat Document

A chat is a folder on Drive with MIME type `application/eigenchat` and extension `.eigenchat`:

```
my-team-chat.eigenchat/                    (pathId: abc, mimeType: application/eigenchat)
└── rooms/
    ├── room-{roomId}/                     (pathId: def, type: folder)
    │   ├── room.db                        (pathId: ghi, mimeType: application/x-sqlite3)
    │   │   └── settings table (room metadata/context)
    │   │   └── messages table
    │   │   └── reactions table
    │   │   └── read_state table
    │   └── media/                         (pathId: jkl, type: folder)
    │       ├── image1.png
    │       └── file1.pdf
    ├── room-{roomId2}/
    │   ├── room.db
    │   └── media/
    └── ...
```

There is no mandatory chat-level `chat.db`. Room metadata lives with room messages in the same room database, so room ACL and room data stay aligned.

### 3.2 System Chat Folder

Each user gets an `eigen.chat/` folder (similar to `eigen.docs/`, `eigen.stickies/`) created on first use:

```
/data/home/{userId}/
├── mounts/
│   └── default/
│       └── metadata.db    # Contains eigen.chat folder + chat documents
├── eigen.mail/
├── eigen.contacts/
└── ...
```

The `eigen.chat/` folder is a regular Drive folder containing `.eigenchat` documents. Users can also create `.eigenchat` documents anywhere in their Drive.

### 3.3 Embedded Chat (Comments)

A `.eigendoc` or `.eigenstickies` folder can contain an embedded `.eigenchat` subfolder for comments:

```
my-document.eigendoc/
├── data.db                    # Yjs document data (existing)
├── media/                     # Document media (existing)
└── comments.eigenchat/        # Embedded chat for document comments
    └── rooms/
        └── room-general/
            ├── room.db
            └── media/
```

The embedded chat inherits ACL from the parent document — anyone who can read the doc can read comments, anyone who can write can post.

---

## 4. Database Schemas

### 4.1 room.db (per room)

Each room folder has one SQLite database (`room.db`) containing both room metadata and room activity.

**settings** (single-row table)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Room ID (UUID) |
| `name` | TEXT | Room display name (e.g., `#lounge`, `Card: API migration`) |
| `description` | TEXT | Optional room description |
| `type` | TEXT | `open` / `private` / `dm` / `comment-thread` |
| `createdBy` | TEXT | User ID of creator |
| `createdAt` | INTEGER | Timestamp |
| `updatedAt` | INTEGER | Timestamp |
| `contextKind` | TEXT | `standalone` / `doc-comment` / `sticky-card` |
| `contextRef` | TEXT | JSON string with host reference data |

`contextRef` examples:
- Doc comment room: `{ "docPathId": "...", "threadId": "..." }`
- Sticky card room: `{ "boardPathId": "...", "cardId": "..." }`

**messages**

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `authorId` | TEXT | User ID |
| `authorEmail` | TEXT | For display resolution |
| `type` | TEXT | `message` / `emote` / `whisper` / `system` / `join` / `leave` |
| `content` | TEXT | Message text (markdown) |
| `whisperTo` | TEXT | User ID (only for whisper type) |
| `replyTo` | TEXT | Message ID for threaded replies |
| `editedAt` | INTEGER | NULL if not edited |
| `deletedAt` | INTEGER | Soft delete timestamp |
| `createdAt` | INTEGER | Timestamp |

**reactions**

| Column | Type | Description |
|--------|------|-------------|
| `messageId` | TEXT FK | References messages.id |
| `userId` | TEXT | User ID |
| `emoji` | TEXT | Emoji character |
| `createdAt` | INTEGER | Timestamp |

**read_state**

| Column | Type | Description |
|--------|------|-------------|
| `userId` | TEXT | User ID |
| `lastReadAt` | INTEGER | Timestamp of last read message |
| `lastReadMessageId` | TEXT | Last read message ID |
| `muted` | INTEGER | 0/1 for per-user mute state |

Indexes:
- `messages(createdAt)` for pagination
- `messages(replyTo)` for thread queries
- `messages(authorId)` for author history
- `reactions(messageId, userId, emoji)` unique
- `read_state(userId)` unique

### 4.2 Why settings table in room.db (not room.json)?

- **Transactional consistency**: update settings and message-related state atomically when needed.
- **Schema safety**: Drizzle migrations and constraints are easier with SQL tables than JSON files.
- **Queryability**: sorting/filtering rooms by `updatedAt`, `type`, or context fields is straightforward.
- **Less file I/O complexity**: avoids parse/write races and partial writes on JSON files.

### 4.3 No mandatory chat-level database

The `.eigenchat` root has no required `chat.db`. Room discovery is:

1. List child room folders under `rooms/` using Drive metadata.
2. Open each accessible `room.db` and read its single `settings` row.

ACL remains the source of truth for access; `room.db` stores room state, not authorization policy.

---

## 5. API Design

### 5.1 Backend Class

New domain class: `apps/api/src/lib/chat/chat.ts`

```
apps/api/src/lib/chat/
├── chat.ts            # Chat business logic class
├── schema.ts          # Drizzle schemas (room.db: settings/messages/reactions/read_state)
├── db-config.ts       # ROOM_DB_CONFIG + migrations
├── sse-events.ts      # SSE event builders
└── index.ts           # Exports
```

The `Chat` class is instantiated per-chat-document (not per-user like Drive). It receives a `Drive` reference and the `.eigenchat` path entry, similar to how `CollabDocument` works.

### 5.2 Route Structure

New router: `apps/api/src/routes/chat.ts`

```
# Chat document management
POST   /chat/:ownerId/:mountId/:parentId/create     # Create .eigenchat document
GET    /chat/:ownerId/:mountId/:chatId/rooms         # List rooms in a chat
POST   /chat/:ownerId/:mountId/:chatId/rooms         # Create room
DELETE /chat/:ownerId/:mountId/:chatId/rooms/:roomId  # Delete room

# Room operations (full drive paths)
GET    /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages?before=&limit=  # Paginated messages
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages                  # Post message
PATCH  /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId       # Edit message
DELETE /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId       # Delete message

# Presence & membership
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/enter     # Enter room (presence)
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/leave     # Leave room
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/read      # Mark as read
GET    /chat/:ownerId/:mountId/:chatId/rooms/:roomId/members    # List members

# Reactions
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId/react
DELETE /chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId/react/:emoji

# Media upload (uses existing Drive upload mechanism)
POST   /chat/:ownerId/:mountId/:chatId/rooms/:roomId/upload
```

All routes use full Drive paths (`ownerId/mountId/chatId/roomId`) so ACL checks work naturally through the existing Drive permission system.

`GET /rooms` does not query a central `chat.db`. It enumerates `rooms/` subfolders and reads each room's `settings` row from `room.db`.

### 5.3 Embedded Chat Shorthand

For document comments, a convenience endpoint resolves the embedded chat:

```
GET  /chat/:ownerId/:mountId/:docId/comments/...
```

This internally resolves the `comments.eigenchat` child of the document folder and delegates to the standard chat routes.

---

## 6. Real-Time Notifications

### 6.1 Architecture

Chat uses the existing SSE system, **not** WebSockets. The flow:

```
User posts message
  → API route handler
    → Chat.postMessage()
      → Insert into room.db
      → Notify sender's Home (immediate local update)
      → Notify other room members' Homes (cross-user delivery)
        → Each Home.notify() → SSE stream → Client handler
          → Cache invalidation + toast (if not active room)
```

### 6.2 SSE Event Types

New event types in `packages/lib/src/types/sse.ts`:

```
chat:message_posted      # New message in a room
chat:message_edited      # Message was edited
chat:message_deleted      # Message was deleted
chat:reaction_added       # Reaction added to message
chat:reaction_removed     # Reaction removed
chat:room_created         # New room created
chat:room_deleted         # Room deleted
chat:member_joined        # User entered room
chat:member_left          # User left room
chat:typing               # User is typing (lightweight)
```

### 6.3 Cross-User Notification

When a message is posted, the server needs to notify all room members. This follows the same pattern as ACL propagation in Drive:

```typescript
// In Chat class
async postMessage(roomId: string, content: string, type: MessageType): Promise<Message> {
    // 1. Insert message into room.db
    const message = await this.insertMessage(roomId, content, type);

    // 2. Notify sender (immediate SSE to their tabs)
    this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_POSTED, {
        chatId: this.path.id,
        roomId,
        message
    }));

    // 3. Notify other room members
    await this.notifyRoomMembers(roomId, SSEventType.CHAT_MESSAGE_POSTED, {
        chatId: this.path.id,
        roomId,
        message
    });

    return message;
}
```

### 6.4 Notification Delivery: `notifyRoomMembers()`

Similar to `propagateACLChange()` in `acl-propagation.ts`:

```typescript
async notifyRoomMembers(roomId: string, type: ChatEventType, data: ChatEventData): Promise<void> {
    const members = this.getMembers(roomId);
    const event = buildChatEvent(type, data);

    for (const member of members) {
        if (member.userId === this.home.user.id) continue; // Skip sender
        try {
            const user = await getUserByEmail(member.email);
            if (user) {
                const home = await getHome(user);
                home.notify(event);
            }
        } catch (error) {
            console.error(`Failed to notify chat member ${member.email}:`, error);
        }
    }
}
```

**Current limitation**: This is an in-process loop, same as ACL propagation. For a monolith with <100 concurrent users, this is fine. See [6.5] for scaling.

### 6.5 Scaling Considerations

**Phase 1 (current monolith):**
Direct in-process `getHome(user).notify(event)` calls. Simple, no infrastructure.

**Phase 2 (batched delivery):**
For rooms with many members, batch notifications instead of one-by-one:

```typescript
// Instead of looping through members:
await this.home.notifyBatch(memberUserIds, event);

// Home.notifyBatch collects all SSE listeners across homes in one pass
```

This avoids the overhead of `getHome()` per member when multiple members are already loaded.

**Phase 3 (distributed):**
When scaling horizontally (multiple API servers), replace direct `home.notify()` with a lightweight pub/sub:
- Option A: SQLite-based notification queue (poll-based, simple)
- Option B: HTTP push between API server instances (as mentioned in `acl-propagation.ts` comments)
- Option C: External pub/sub (Redis, NATS) — but this adds infrastructure

The current abstraction (`notifyRoomMembers` as a separate function) makes switching implementations easy, same pattern as `propagateACLChange()`.

### 6.6 Typing Indicators

Typing events are fire-and-forget SSE events — no database persistence. The client sends a POST to a lightweight endpoint, which triggers SSE to other room members. Debounced client-side (send at most once per 2 seconds while typing).

```
POST /chat/:ownerId/:mountId/:chatId/rooms/:roomId/typing
```

No response body needed. Server broadcasts `chat:typing` SSE to other members.

---

## 7. ACL & Permissions

### 7.1 Inheritance Model

Chat permissions cascade through Drive's existing ACL inheritance:

```
.eigenchat folder ACL        → applies to all rooms (unless overridden)
  └── room-{id}/ folder ACL  → overrides for specific room
```

If a room folder has no ACL, it inherits from the parent `.eigenchat` folder. If the `.eigenchat` folder has no ACL, it inherits from its parent (the user's Drive folder or the parent document).

This is exactly how Drive already works (`acl.ts` → `getEffectiveACL` walks up the tree).

### 7.2 Permission Mapping

| Drive ACL | Chat Permission |
|-----------|----------------|
| `read: true` | Can read messages, see members, peek |
| `write: true` | Can post messages, react, upload media |
| `owner` (creator) | Can create/delete rooms, manage members, set room ACL |
| `public: true` | Room is visible to all users (open room) |

### 7.3 Sharing a Chat or Room

- **Share entire chat**: Set ACL on the `.eigenchat` folder → user gets access to all rooms
- **Share single room**: Set ACL on the `room-{id}/` folder → user gets access to that room only
- **Embedded chat (comments)**: Inherits from the parent `.eigendoc` / `.eigenstickies` ACL — no separate sharing needed

Sharing triggers the existing `propagateACLChange()` → `receiveACLChange()` flow, which updates the target user's `shared.db` and sends them an SSE notification ("Chat shared with you").

### 7.4 DM Rooms

Direct messages are just `type: 'dm'` rooms with ACL restricted to two users. No special handling — the ACL system enforces access.

---

## 8. Embedded Chat (Docs & Stickies)

### 8.1 Document Comments

When a user opens a `.eigendoc` and wants to add a comment:

1. Client checks if `comments.eigenchat` exists as a child of the doc folder
2. If not, creates it via `POST /chat/:ownerId/:mountId/:docId/create` (with name `comments`)
3. The embedded chat gets a default `#general` room
4. Comments appear in a side panel or bottom panel within the document editor

### 8.2 Stickies Board Discussions

Same pattern for `.eigenstickies`:

1. A `comments.eigenchat` child folder holds board-level discussion
2. Optionally, per-card rooms could be created (room name = card title)
3. The stickies UI shows a chat panel when a card is selected

### 8.3 Room Relation Model (Doc threads and Sticky cards)

For embedded chat, relation lookup should be **host-first**:

- **Docs**: comment thread records store `roomId` and anchor metadata.
- **Stickies**: card records store `discussionRoomId`.

This gives O(1) relation lookup from the UI object you already have (thread/card), instead of scanning all rooms.

Each room still stores reverse context in `settings.contextKind` + `settings.contextRef` for validation and debugging.

For threaded comments inside a room, `replyTo` remains the thread mechanism:

- Top-level comment: `replyTo: null`
- Reply: `replyTo = topLevelMessageId`

If needed, anchors can be stored in message content JSON (or a dedicated message metadata column), but the room relation itself should stay on the host object.

---

## 9. Media & Attachments

### 9.1 Upload Flow

Media uploads use the existing Drive upload infrastructure:

1. Client uploads file to `POST /chat/.../rooms/:roomId/upload`
2. Server creates file entry in the room's `media/` folder via `mount.createFile()`
3. Server inserts a message of type `message` with content referencing the media path
4. File is stored via the mount's storage backend (LocalKeyStorage or S3)

Thumbnails are generated using the existing `thumbnails.ts` system.

### 9.2 Media References in Messages

Messages reference media by Drive path:

```json
{
    "type": "message",
    "content": "Check this out",
    "attachments": [
        { "pathId": "xyz", "name": "screenshot.png", "mimeType": "image/png", "size": 45000 }
    ]
}
```

The `attachments` field is stored as JSON in the `content` or as a separate column. The client resolves media URLs through the standard Drive file serving endpoint.

---

## 10. Pagination & Performance

### 10.1 Message Pagination

Messages are loaded in reverse chronological order with cursor-based pagination:

```
GET /chat/.../rooms/:roomId/messages?before={messageId}&limit=50
```

The `before` parameter is a message ID. The server queries:

```sql
SELECT * FROM messages
WHERE createdAt < (SELECT createdAt FROM messages WHERE id = :before)
ORDER BY createdAt DESC
LIMIT :limit
```

For the initial load (no `before`), return the most recent N messages.

### 10.2 Unread Counts

Each room stores per-user read progress in `read_state.lastReadMessageId`, enabling efficient unread counts:

```sql
SELECT COUNT(*) FROM messages
WHERE createdAt > (SELECT createdAt FROM messages WHERE id = :lastReadMessageId)
```

This is a per-room query on an indexed column — fast even for large rooms.

### 10.3 Room List Performance

Without a central `chat.db`, room listing is a two-step process:

1. List `rooms/` child folders from Drive metadata.
2. Read the `settings` row from each accessible room's `room.db`.

For typical room counts (tens, not thousands), this is acceptable and keeps ACL behavior simple and correct. If needed later, add an **optional cache/index** for faster room lists — but keep it rebuildable and non-authoritative.

---

## 11. Frontend Architecture

### 11.1 App Structure

```
apps/chat/
├── src/
│   ├── components/
│   │   ├── chat/
│   │   │   ├── room-list.tsx          # Sidebar: room list with unread badges
│   │   │   ├── room-detail.tsx        # Main: message stream + input
│   │   │   ├── room-header.tsx        # Room name, members, peek
│   │   │   ├── message-list.tsx       # Paginated message rendering
│   │   │   ├── message-input.tsx      # Input with /commands, emoji, file upload
│   │   │   ├── message-item.tsx       # Single message (with reactions, reply)
│   │   │   ├── member-list.tsx        # Room members with presence
│   │   │   └── typing-indicator.tsx   # "Alice is typing..."
│   │   └── ...
│   ├── routes/
│   │   ├── __root.tsx
│   │   └── index.tsx
│   └── main.tsx
```

### 11.2 Shared Chat Component

For embedded use in Docs and Stickies, extract core chat components to `packages/ui`:

```
packages/ui/src/components/layout/chat/
├── chat-panel.tsx              # Self-contained chat panel (room list + messages)
├── chat-thread.tsx             # Threaded comment view (for document comments)
├── chat-input.tsx              # Message input with commands
└── chat-message.tsx            # Message rendering
```

These shared components accept a `chatPath` prop (Drive path to the `.eigenchat` folder) and handle everything internally.

### 11.3 Data Fetching

```
packages/lib/src/lib/chat/
├── hooks/
│   ├── use-chat.ts             # Chat document operations
│   ├── use-rooms.ts            # Room listing, creation
│   ├── use-messages.ts         # Message fetching with infinite scroll
│   ├── use-presence.ts         # Room presence tracking
│   └── use-typing.ts           # Typing indicator
├── sse-handlers.ts             # SSE event handlers for cache invalidation
└── index.ts
```

Query keys:

```typescript
export const chatKeys = {
    all: ['chat'] as const,
    rooms: (chatId: string) => [...chatKeys.all, 'rooms', chatId] as const,
    room: (chatId: string, roomId: string) => [...chatKeys.rooms(chatId), roomId] as const,
    messages: (chatId: string, roomId: string) => [...chatKeys.all, 'messages', chatId, roomId] as const,
    members: (chatId: string, roomId: string) => [...chatKeys.all, 'members', chatId, roomId] as const,
};
```

### 11.4 Infinite Scroll

`useMessages` uses TanStack Query's `useInfiniteQuery`:

```typescript
useInfiniteQuery({
    queryKey: chatKeys.messages(chatId, roomId),
    queryFn: ({ pageParam }) => fetchMessages(chatId, roomId, pageParam),
    getNextPageParam: (lastPage) => lastPage.messages[lastPage.messages.length - 1]?.id,
    initialPageParam: undefined, // Start from latest
});
```

Scroll up to load older messages. New messages arrive via SSE → append to the first page.

---

## 12. Migration & Rollout

### Phase 1: Core Infrastructure

1. Define MIME type `application/eigenchat` and extension `.eigenchat`
2. Create `chat.ts` domain class, schemas, db-config
3. Create chat API routes
4. Add SSE event types and handlers
5. Add `Chat` instance management to `Home` (or lazy-load per chat document)

### Phase 2: Standalone Chat App

1. Create `apps/chat/` frontend application
2. Room list, message stream, input, presence
3. MUD-inspired commands (`/me`, `/whisper`, `/go`)
4. File upload in rooms

### Phase 3: Embedded Comments

1. Add `comments.eigenchat` creation to docs/stickies
2. Extract shared chat components to `packages/ui`
3. Add comment panel to document editor
4. Add discussion panel to stickies board

### Phase 4: Polish

1. @mentions with notification
2. Search across messages
3. Message pinning
4. Room bookmarks
5. Emoji picker

---

## 13. Open Questions

### Should rooms be folders or database rows?

**Current proposal: folders + per-room database.**

- Room identity and ACL come from the room folder in Drive.
- Room metadata, messages, reactions, and read state live in that room's `room.db`.
- No mandatory chat-level room catalog.

Trade-off: Listing rooms requires reading multiple room DB files. Benefit: no ACL mismatch between root metadata and room visibility.

### room.json or settings table in room.db?

**Current proposal: settings table in `room.db`.**

- Better transactional guarantees
- Better schema evolution via migrations
- Better filtering/sorting/query support
- Fewer file consistency edge cases

### How to handle very active rooms?

SQLite handles tens of thousands of messages per room well. For extremely active rooms (100k+ messages), the per-room database design means we can archive/compact individual rooms without affecting others.

### Should room settings include a message count cache?

Yes, probably. Store `messageCount` and `lastMessageAt` in each room's `settings` row and update on message insert.

### Typing indicators: SSE or separate endpoint?

SSE. Typing events are ephemeral — no persistence needed. The server broadcasts `chat:typing` to room members. If a member's SSE connection is lost, they just don't see typing indicators until reconnect. No data loss.

### How to handle @mentions across rooms?

When a message contains `@email`, the server:
1. Resolves the email to a user
2. Sends a targeted SSE notification to that user's Home, regardless of their active room
3. The client shows a badge on the room and optionally a toast

This is a notification, not a new message delivery mechanism — the message is always in the room's database.

---

## 14. Honest Analysis

### What works well about this design

- **Zero new infrastructure** — SSE, SQLite, Drive storage, ACL, Home singleton — all existing
- **Consistent patterns** — follows eigendoc/eigenstickies exactly (folder + child databases + media subfolder)
- **Embeddable** — the same chat system powers standalone rooms AND document comments
- **Paginated by default** — SQLite queries with cursor pagination, no Yjs bloat
- **ACL for free** — Drive's permission model handles sharing, public rooms, per-room access
- **Cross-user notifications** — `propagateACLChange` pattern already solves the hard problem of notifying other users' Home instances

### What's risky or limited

- **SSE is one-directional**: Clients can't push through SSE. Every user action is an HTTP POST → server processes → SSE broadcast. This adds latency compared to WebSockets (one round trip per message vs. persistent bidirectional). For chat, this means ~50-200ms per message delivery. Acceptable for team chat, noticeable for rapid-fire conversations.

- **No offline delivery queue**: If a user's SSE connection drops, they miss events. On reconnect, the client must re-fetch (query `room.db` for anything after `lastReadMessageId`). This is fine — same pattern as Drive/Mail SSE — but it means the client must be smart about reconnection.

- **Room list cost without a root DB**: Listing rooms means opening multiple `room.db` files to read settings. This is the cost of keeping ACL boundaries clean. Mitigation: lazy-open with connection pooling, cache room cards in memory, and optionally add a rebuildable non-authoritative index later.

- **Notification fanout**: For a room with 100 members, posting a message means 99 `getHome()` calls + SSE pushes. The monolith can handle this for small-to-medium teams. For large rooms, batching (Phase 2 in [6.5]) becomes necessary. The `notifyRoomMembers()` abstraction allows swapping implementations.

- **No real-time cursor/selection sync**: Unlike Yjs-powered docs, chat doesn't share cursor position. This is intentional — chat is append-only, not collaborative editing. Typing indicators serve the same purpose.

### Alternatives considered

| Approach | Why not |
|----------|---------|
| **Yjs for chat** | Can't paginate, grows forever, overkill for append-only data |
| **WebSocket server** | New infrastructure, new connection management, not needed for monolith scale |
| **Separate chat database (not Drive)** | Loses ACL inheritance, storage accounting, sharing model. Duplicates concerns. |
| **Single database per chat** | All rooms in one DB → no per-room ACL, harder to delete/export rooms, larger query scans |
| **External message broker (Redis)** | Premature infrastructure. Can be added in Phase 3 if needed. |

### Verdict

This design is a natural extension of Eigen's architecture. The "chat as a Drive document" model gives us sharing, permissions, storage, and embedding for free. The per-room SQLite approach provides isolation and pagination. SSE handles real-time delivery using the existing pattern.

The main technical risk is notification fanout for large rooms, which is solvable with batching and — much later — with a pub/sub layer. For a team workspace product (tens of users, not thousands), the direct `home.notify()` approach is sufficient.

---

## File Structure Summary

### New files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/chat/chat.ts` | Chat business logic class |
| `apps/api/src/lib/chat/schema.ts` | Drizzle schemas (`room.db`: settings/messages/reactions/read_state) |
| `apps/api/src/lib/chat/db-config.ts` | Database configs with migrations |
| `apps/api/src/lib/chat/sse-events.ts` | SSE event builders |
| `apps/api/src/lib/chat/index.ts` | Exports |
| `apps/api/src/routes/chat.ts` | Chat API routes |
| `packages/lib/src/types/chat.ts` | Chat type definitions |
| `packages/lib/src/lib/chat/hooks/use-chat.ts` | Chat hooks |
| `packages/lib/src/lib/chat/hooks/use-rooms.ts` | Room hooks |
| `packages/lib/src/lib/chat/hooks/use-messages.ts` | Message hooks (infinite query) |
| `packages/lib/src/lib/chat/sse-handlers.ts` | SSE handlers for cache invalidation |
| `packages/ui/src/components/layout/chat/chat-panel.tsx` | Shared chat panel component |
| `apps/chat/` | Standalone chat frontend app |

### Modified files

| File | Change |
|------|--------|
| `packages/lib/src/types/sse.ts` | Add `chat:` event types |
| `packages/lib/src/lib/sse/hooks/use-sse.ts` | Register chat SSE handler |
| `apps/api/src/lib/home/home.ts` | Add chat reference (or lazy-load) |
| `apps/api/src/lib/drive/drive.ts` | Add `createChat()` method (like `createDoc`, `createStickies`) |
| `apps/api/src/lib/mount/mount.ts` | Support `chat` type in `createFolder()` |
| `packages/lib/src/types/drive.ts` | Add `chat` to DrivePath type union |
| `packages/ui/src/components/layout/drive/file-icon-helper.tsx` | Add icon for `.eigenchat` |
