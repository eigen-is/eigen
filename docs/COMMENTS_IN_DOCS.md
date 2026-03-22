# Comments in Documents

> **TLDR**: Add a `comments.db` inside each container document (eigendoc/stickies/slides/sheets) to index embedded
> comment chats. Enables fast "where am I mentioned" filtering, comment resolution status, and activity summaries —
> without opening N individual chat databases. `ChatRoom` discovers its container during `init()` by walking up the
> `parentId` chain. Updates to `comments.db` happen server-side in `ChatRoom.postMessage()`.

## Problem

When opening a document with 20 comments, there's no way to know which comments mention the current user, which are
resolved, or what the latest activity is — without opening all 20 `*.eigenchat/data.db` files and scanning every
message. This is O(N) database opens and unacceptable for a comment sidebar.

## How a Chat Knows It's Embedded

A chat does **not** inherently know. The `ChatRoom` class receives a `DrivePath` during construction:

```typescript
// apps/api/src/lib/chat/chat.ts
constructor(drive: Drive, home: Home, path: DrivePath) {
    this.drive = drive;
    this.home = home;
    this.path = path;  // ← the .eigenchat DrivePath
}
```

The `DrivePath` has a `parentId` field. By walking up the parent chain via `Drive.getPath()`, the server can determine
if the chat lives inside a container document.

**Path chain for an embedded comment chat:**

```
comment-123.eigenchat   type=chat     parentId → [chat-folder-id]
chat/                   type=folder   parentId → [eigendoc-id]
my-doc.eigendoc         type=doc      parentId → [projects-folder-id]    ← container
Projects/               type=folder   parentId → [root-id]
root                    type=folder   parentId → null
```

`CollabDocument.create()` always creates this structure — add `comments.db` here:

```typescript
// apps/api/src/lib/collab/collabDocument.ts — modified
static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
    await drive.touchFile(mountId, docId, 'data.db', 'application/x-sqlite3');
    await drive.touchFile(mountId, docId, 'comments.db', 'application/x-sqlite3');  // ← NEW
    await drive.createFolder(mountId, docId, 'media');
    await drive.createFolder(mountId, docId, 'chat');
}
```

So the chain is always: `eigenchat → chat/ folder → container document`.

**For a standalone chat** (top-level `.eigenchat` in Drive), the parent chain goes directly to a regular folder or root
— no collab type ancestor is found.

## Solution: `comments.db`

### Storage

Each container document gets a `comments.db` in its root, alongside `data.db`:

```
my-doc.eigendoc/
├── data.db              (Yjs collaborative state)
├── comments.db          (comment metadata index) ← NEW
├── media/
└── chat/
    ├── comment-1.eigenchat/
    └── comment-2.eigenchat/
```

Created eagerly by `CollabDocument.create()` — every container document has one from birth. No backward
compatibility needed (data is throwaway during dev).

### Schema

```typescript
// apps/api/src/lib/chat/comment-schema.ts
export const comments = sqliteTable('comments', {
    chatName: text('chatName').primaryKey(),
    status: text('status').notNull().default('open'),       // 'open' | 'resolved'
    resolvedBy: text('resolvedBy'),
    resolvedAt: integer('resolvedAt', {mode: 'timestamp'}),
    lastAuthorEmail: text('lastAuthorEmail'),
    lastMessageSnippet: text('lastMessageSnippet'),
    lastActivityAt: integer('lastActivityAt', {mode: 'timestamp'}),
    messageCount: integer('messageCount').notNull().default(0),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});

export const commentMentions = sqliteTable('comment_mentions', {
    chatName: text('chatName').notNull(),
    email: text('email').notNull(),
}, (table) => ({
    pk: primaryKey({columns: [table.chatName, table.email]}),
    emailIdx: index('idx_mentions_email').on(table.email),
}));
```

**`comments`**: One row per embedded comment chat. Stores status, activity summary.
**`comment_mentions`**: Normalized mention index. One row per (comment, mentioned user).

### DatabaseConfig

```typescript
// apps/api/src/lib/chat/comment-db-config.ts
export const COMMENT_INDEX_DB_CONFIG: DatabaseConfig<typeof commentSchema> = {
    name: 'comment-index',
    currentVersion: 1,
    schema: commentSchema,
    migrations: [{
        version: 1,
        up: (db) => db.exec(`
            CREATE TABLE IF NOT EXISTS comments (
                chatName TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'open',
                resolvedBy TEXT,
                resolvedAt INTEGER,
                lastAuthorEmail TEXT,
                lastMessageSnippet TEXT,
                lastActivityAt INTEGER,
                messageCount INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS comment_mentions (
                chatName TEXT NOT NULL,
                email TEXT NOT NULL,
                PRIMARY KEY (chatName, email)
            );
            CREATE INDEX IF NOT EXISTS idx_mentions_email ON comment_mentions(email);
        `)
    }]
};
```

## ChatRoom: Container Discovery

Add a `containerPath` field to `ChatRoom`, resolved during `init()` via `Drive.findContainerPath()`
(added in [ACL_BUBBLING.md](ACL_BUBBLING.md)):

```typescript
// apps/api/src/lib/chat/chat.ts — modifications
export class ChatRoom {
    private drive: Drive;
    private home: Home;
    private path: DrivePath;
    private containerPath: DrivePath | null = null;   // ← NEW
    private db!: BunSQLiteDatabase<typeof schema>;
    private managedDb!: ManagedDatabase<typeof schema>;

    async init(): Promise<ChatRoom> {
        // ... existing data.db init ...

        // Walk parentId chain to find outermost collab container (if any)
        this.containerPath = await this.drive.findContainerPath(
            this.path.mountId, this.path.parentId ?? ''
        );

        return this;
    }

    get isEmbedded(): boolean {
        return this.containerPath !== null;
    }
}
```

`Drive.findContainerPath()` delegates to the shared `findContainerPath()` in `acl.ts`, which walks the full `parentId`
chain to root and returns the outermost collab ancestor. For the standard eigendoc structure the walk is short
(chat/ folder → doc → parent folder → root). Negligible cost, done once per `ChatRoom.init()`.

## CommentIndex Service

```typescript
// apps/api/src/lib/chat/comment-index.ts
export class CommentIndex {
    private db: BunSQLiteDatabase<typeof commentSchema>;

    constructor(db: BunSQLiteDatabase<typeof commentSchema>) {
        this.db = db;
    }

    async ensureComment(chatName: string): Promise<void> {
        await this.db.insert(commentSchema.comments)
            .values({chatName, createdAt: new Date()})
            .onConflictDoNothing();
    }

    async updateActivity(chatName: string, authorEmail: string, snippet: string): Promise<void> {
        await this.db.update(commentSchema.comments)
            .set({
                lastAuthorEmail: authorEmail,
                lastMessageSnippet: snippet.slice(0, 100),
                lastActivityAt: new Date(),
                messageCount: sql`messageCount + 1`,
            })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async addMention(chatName: string, email: string): Promise<void> {
        await this.db.insert(commentSchema.commentMentions)
            .values({chatName, email: email.toLowerCase()})
            .onConflictDoNothing();
    }

    async resolve(chatName: string, email: string): Promise<void> {
        await this.db.update(commentSchema.comments)
            .set({status: 'resolved', resolvedBy: email, resolvedAt: new Date()})
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async reopen(chatName: string): Promise<void> {
        await this.db.update(commentSchema.comments)
            .set({status: 'open', resolvedBy: null, resolvedAt: null})
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async list(): Promise<Comment[]> {
        return this.db.select().from(commentSchema.comments)
            .orderBy(commentSchema.comments.createdAt)
            .all();
    }

    async mentionsForUser(email: string): Promise<Comment[]> {
        return this.db.select({comment: commentSchema.comments})
            .from(commentSchema.comments)
            .innerJoin(
                commentSchema.commentMentions,
                eq(commentSchema.comments.chatName, commentSchema.commentMentions.chatName)
            )
            .where(eq(commentSchema.commentMentions.email, email.toLowerCase()))
            .orderBy(desc(commentSchema.comments.lastActivityAt))
            .all()
            .then(rows => rows.map(r => r.comment));
    }

    async unresolvedCount(): Promise<number> {
        const result = await this.db.select({count: sql<number>`COUNT(*)`})
            .from(commentSchema.comments)
            .where(eq(commentSchema.comments.status, 'open'))
            .get();
        return result?.count ?? 0;
    }
}
```

### Opening `comments.db`

`comments.db` is created by `CollabDocument.create()`, so it always exists:

```typescript
// apps/api/src/lib/chat/comment-index.ts
export async function openCommentIndex(
    drive: Drive,
    containerPath: DrivePath
): Promise<CommentIndex> {
    const dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) throw new ApiError(404, 'comments.db not found');
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id);
    return new CommentIndex(managed.db);
}
```

`ManagedDatabase` handles WAL mode, versioning, and caching. No explicit cleanup — registered with Home's DB tracker.

## Updating the Index

### On Message Post

In `ChatRoom.postMessage()`, after the message is inserted and SSE events are sent:

```typescript
// apps/api/src/lib/chat/chat.ts — at the end of postMessage()

// Update comment index if embedded
if (this.containerPath && type !== 'whisper') {
    try {
        const commentIndex = await openCommentIndex(this.drive, this.containerPath);
        await commentIndex.ensureComment(this.path.name);
        await commentIndex.updateActivity(this.path.name, authorEmail, content);

        // Index mentions
        const mentionedEmails = extractMentionedEmails(content);
        for (const email of mentionedEmails) {
            await commentIndex.addMention(this.path.name, email);
        }
    } catch (error) {
        console.error('Failed to update comment index:', error);
        // Non-fatal: message is already posted, index is best-effort
    }
}
```

`extractMentionedEmails` reuses the regex from `packages/lib/src/validation/email.ts` (`EMAIL_FIND_REGEX`):

```typescript
// apps/api/src/lib/chat/mentions.ts
import {EMAIL_FIND_REGEX} from '@workspace/lib/validation';

export function extractMentionedEmails(content: string): string[] {
    const matches = content.match(EMAIL_FIND_REGEX);
    if (!matches) return [];
    return [...new Set(matches.map(e => e.toLowerCase()))];
}
```

### On Comment Chat Creation

When `CreateCommentDialog` creates a chat via `POST /drive/:ownerId/:mountId/folder/:pathId/chat`, the server creates
the `.eigenchat` inside the container's `chat/` folder. The first message post (which happens immediately after
creation in `CreateCommentDialog`) triggers `ensureComment()` + `updateActivity()`. No separate creation hook needed —
the `ensureComment` upsert handles it.

### On Message Edit/Delete

Add index updates to `ChatRoom.editMessage()` and `ChatRoom.deleteMessage()`:

- **Edit**: Update `lastMessageSnippet` if the edited message is the most recent. Re-extract mentions.
- **Delete**: Decrement `messageCount`. If deleted message was the last one, update snippet from previous message.

These are best-effort — a stale snippet or count is low-impact.

## API Routes

Added to the existing `apps/api/src/routes/collab.ts` — comments are document-scoped metadata, so they belong alongside
`/info` and `/revisions` under the same `collab/:ownerId/:mountId/:pathId` prefix.

To keep routes thin, add a helper that combines `getPath` + `openCommentIndex`:

```typescript
// apps/api/src/lib/chat/comment-index.ts — add alongside openCommentIndex
export async function getCommentIndex(drive: Drive, mountId: string, pathId: string): Promise<CommentIndex> {
    const path = await drive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Container not found');
    return openCommentIndex(drive, path);
}
```

`SharedDrive.getPath()` already enforces read permission — no explicit `canRead` check needed in GET routes.
The PATCH route needs an explicit `canWrite` check since `getPath` only verifies read access.

```typescript
// List all comments in a container document
.get("/collab/:ownerId/:mountId/:pathId/comments", async ({params, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const index = await getCommentIndex(drive, params.mountId, params.pathId);
    return await index.list();
}, {auth: true})

// List comments that mention the current user
.get("/collab/:ownerId/:mountId/:pathId/comments/mentions", async ({params, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const index = await getCommentIndex(drive, params.mountId, params.pathId);
    return await index.mentionsForUser(user.email);
}, {auth: true})

// Unresolved comment count
.get("/collab/:ownerId/:mountId/:pathId/comments/unresolved-count", async ({params, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const index = await getCommentIndex(drive, params.mountId, params.pathId);
    return {count: await index.unresolvedCount()};
}, {auth: true})

// Resolve or reopen a comment
.patch("/collab/:ownerId/:mountId/:pathId/comments/:chatName/status", async ({params, body, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
        throw new ApiError(403, 'No write permission');
    }
    const index = await getCommentIndex(drive, params.mountId, params.pathId);
    if (body.status === 'resolved') {
        await index.resolve(params.chatName, user.email);
    } else {
        await index.reopen(params.chatName);
    }
    return {success: true};
}, {
    body: t.Object({status: t.Union([t.Literal('resolved'), t.Literal('open')])}),
    auth: true
})
```

This keeps comment routes consistent with the existing collab pattern (`/collab/:ownerId/:mountId/:pathId/info`,
`/collab/:ownerId/:mountId/:pathId/revisions`). The `pathId` is the container document — the frontend already has this
because it's the document being viewed. `chatName` is the `.eigenchat` folder name (matches `CommentMark.chatName` in
Tiptap and `CardItem.chatName` in stickies Yjs).

## Frontend Hooks

Routes live under `/collab/...`, so add `collabApi` to `packages/lib/src/core/api.ts`:

```typescript
export const collabApi = api.collab;
```

```typescript
// packages/lib/src/core/chat/hooks/use-comments.ts
import {collabApi} from '../../api';

export const commentKeys = {
    all: ['comments'] as const,
    container: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.all, ownerId, mountId, containerId] as const,
    list: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'list'] as const,
    mentions: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'mentions'] as const,
    unresolvedCount: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'unresolved-count'] as const,
};

export function useComments(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.list(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ownerId})({mountId})({pathId: containerId}).comments.get();
            if (response.error) throw new AppError(response);
            return response.data ?? [];
        },
        enabled: !!containerId,
    });
}

export function useMyMentions(ownerId: string, mountId: string, containerId: string) {
    return useQuery({
        queryKey: commentKeys.mentions(ownerId, mountId, containerId),
        queryFn: async () => {
            const response = await collabApi({ownerId})({mountId})({pathId: containerId}).comments.mentions.get();
            if (response.error) throw new AppError(response);
            return response.data ?? [];
        },
        enabled: !!containerId,
    });
}

export function useResolveComment(ownerId: string, mountId: string, containerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({chatName, status}: {chatName: string, status: 'resolved' | 'open'}) => {
            const response = await collabApi({ownerId})({mountId})({pathId: containerId})
                .comments({chatName}).status.patch({status});
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: commentKeys.container(ownerId, mountId, containerId)});
        },
        onError: onMutationError,
    });
}
```

## Document-Level Integration

Each app passes its container pathId to the comment hooks:

- **Docs**: `path.id` (the eigendoc DrivePath) — already available in `editor.tsx`
- **Stickies**: `path.id` (the eigenstickies DrivePath) — available in board component
- **Slides**: `path.id` — available in editor
- **Sheets**: `path.id` — available in editor

The comment sidebar component (shared in `packages/ui`) receives `ownerId`, `mountId`, `containerId` and renders:

1. **All comments** with status badges (open = yellow dot, resolved = green check)
2. **"Mentions" filter** toggle — shows only comments where current user is in `comment_mentions`
3. **Resolve/Reopen** button per comment
4. **Click** → opens the comment chat dialog (existing `ViewCommentDialog` or equivalent)

## Active vs Orphaned Comments

When a user deletes a CommentMark in a doc (removes annotation from text) or deletes a card in stickies, the
`.eigenchat` stays on disk and `comments.db` retains the row. This is intentional — the chat is preserved for version
revert and the index is a metadata cache, not an authority on what's live.

**The document structure is the source of truth for which comments are "active":**

- **Docs**: scan Tiptap document for `CommentMark` nodes → extract `chatName` attributes
- **Stickies**: scan Y.Map cards → extract cards with `chatName`
- **Slides/Sheets**: same pattern

**Filtering is a frontend concern.** The Yjs document is already loaded in the frontend, so getting the active set is
trivial. The comment sidebar flow:

1. `GET /collab/.../comments` → returns ALL comments from the index
2. Frontend intersects with active `chatName`s from the Yjs state
3. Show active comments first, optionally show orphaned ones in a collapsed "archived" section

No `archived` status in the schema — that would couple the DB to document format and require Yjs observers on the
server. The `open | resolved` status tracks comment thread state, not whether the anchor exists.

## Integration with Mentions System

See [RESEARCH_MENTIONS.md](RESEARCH_MENTIONS.md). The `containerPath` field on `ChatRoom` enables proper deep linking
when mention notifications are added (Phase 2 of the mentions plan):

```typescript
// In ChatRoom — when creating mention notification for a @mentioned email:
const link = this.containerPath
    ? getDocUrl(this.containerPath.ownerId, this.containerPath.mountId, this.containerPath.id)
    : getChatRoomUrl(this.path.ownerId, this.path.mountId, this.path.id);
```

- **Standalone chat mention** → notification links to chat room
- **Embedded comment mention** → notification links to the container document

ChatRoom handles the routing. The notification system doesn't need to know about containers — it just receives a link
and a tag. The `comment_mentions` table in `comments.db` and the `notifications.db` from RESEARCH_MENTIONS serve
complementary purposes:

- `comment_mentions` → "which comments in this doc mention me?" (document-scoped sidebar filter)
- `notifications.db` → "what happened across all apps?" (user-scoped inbox)

Both `extractMentionedEmails` implementations should share `EMAIL_FIND_REGEX` from `@workspace/lib/validation`.

## Performance

| Operation | Cost |
|-----------|------|
| Container discovery (`findContainerPath`) | ~4 SQLite lookups by PK for standard structure (once per `ChatRoom.init()`) |
| Index update on message post | 1 DB open (cached by `ManagedDatabase`) + 2-3 INSERTs/UPDATEs |
| List all comments | 1 DB open + 1 SELECT |
| "Where am I mentioned" | 1 DB open + 1 JOIN query (indexed) |
| Resolve/reopen | 1 DB open + 1 UPDATE |

The `comments.db` is tiny: rows = number of comments (typically <100 per document). All operations are sub-millisecond.

## SSE Invalidation

When `ChatRoom.postMessage()` updates the comment index, emit an SSE event so the frontend refreshes the comment sidebar:

```typescript
// apps/api/src/lib/chat/sse-events.ts — add
export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEvent {
    return {
        type: SSEventType.COMMENT_INDEX_UPDATED,
        title: 'Comment updated',
        extra: {containerId, ownerId, mountId}
    } as SSEvent;
}
```

```typescript
// packages/lib/src/types/sse.ts — add to SSEventType
COMMENT_INDEX_UPDATED: 'comment:index-updated',
```

SSE handler invalidates `commentKeys.container(...)`.

## Complete File Changes

| File | Change |
|------|--------|
| **New** `apps/api/src/lib/chat/comment-schema.ts` | Drizzle schema for `comments` + `comment_mentions` |
| **New** `apps/api/src/lib/chat/comment-db-config.ts` | `COMMENT_INDEX_DB_CONFIG` |
| **New** `apps/api/src/lib/chat/comment-index.ts` | `CommentIndex` class + `openCommentIndex()` |
| **New** `apps/api/src/lib/chat/mentions.ts` | `extractMentionedEmails()` |
| **New** `packages/lib/src/core/chat/hooks/use-comments.ts` | Query hooks + keys |
| `apps/api/src/lib/chat/chat.ts` | Add `containerPath` (via `Drive.findContainerPath()`), index updates in `postMessage()` |
| `apps/api/src/lib/collab/collabDocument.ts` | Add `comments.db` creation in `CollabDocument.create()` |
| `packages/lib/src/core/api.ts` | Add `collabApi` export |
| `apps/api/src/routes/collab.ts` | Add comment list/mentions/status routes |
| `packages/lib/src/types/sse.ts` | Add `COMMENT_INDEX_UPDATED` |
| `apps/api/src/lib/chat/sse-events.ts` | Add `buildCommentIndexUpdatedEvent()` |

## What This Does NOT Change

- Chat `data.db` schema — unchanged, messages table stays the same
- Yjs `data.db` — unchanged, collaborative state is separate
- `CommentMark` Tiptap extension — unchanged, still stores `chatName`
- `MediaResolverProvider` — unchanged, still resolves `chatName` → `pathId`
- Standalone chats — no `comments.db` created, no index updates
- `ChatRoom.postMessage()` message flow — index update is appended, non-fatal on failure
