# Comments in Documents

> **TLDR**: Each container document (eigendoc/stickies/slides/sheets) has a `comments.db` that indexes embedded
> comment chats. Enables fast mention filtering, comment resolution status, and activity summaries — without opening N
> individual chat databases. `ChatRoom` discovers its container during `init()` by walking up the `parentId` chain.
> Updates to `comments.db` happen server-side via `ChatRoom.updateCommentIndex()`. Mentions are returned inline with
> the comment list (no separate endpoint).

## How a Chat Knows It's Embedded

A chat does **not** inherently know. The `ChatRoom` class receives a `DrivePath` during construction:

```typescript
// apps/api/src/lib/chat/chat.ts
constructor(drive: Drive, home: Home, path: DrivePath) {
    this.drive = drive;
    this.home = home;
    this.path = path;  // the .eigenchat DrivePath
}
```

The `DrivePath` has a `parentId` field. By walking up the parent chain via `Drive.getPath()`, the server can determine
if the chat lives inside a container document.

**Path chain for an embedded comment chat:**

```
comment-123.eigenchat   type=chat     parentId -> [chat-folder-id]
chat/                   type=folder   parentId -> [eigendoc-id]
my-doc.eigendoc         type=doc      parentId -> [projects-folder-id]    <- container
Projects/               type=folder   parentId -> [root-id]
root                    type=folder   parentId -> null
```

`CollabDocument.create()` always creates this structure — `comments.db` is created here:

```typescript
// apps/api/src/lib/collab/collabDocument.ts
static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
    await drive.touchFile(mountId, docId, 'data.db', 'application/x-sqlite3');
    await drive.touchFile(mountId, docId, 'comments.db', 'application/x-sqlite3');
    await drive.createFolder(mountId, docId, 'media');
    await drive.createFolder(mountId, docId, 'chat');
}
```

So the chain is always: `eigenchat -> chat/ folder -> container document`.

**For a standalone chat** (top-level `.eigenchat` in Drive), the parent chain goes directly to a regular folder or root
— no collab type ancestor is found.

## Solution: `comments.db`

### Storage

Each container document gets a `comments.db` in its root, alongside `data.db`:

```
my-doc.eigendoc/
├── data.db              (Yjs collaborative state)
├── comments.db          (comment metadata index)
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
**`comment_mentions`**: Normalized mention index. One row per (comment, mentioned user). Composite PK deduplicates
automatically — mentioning the same user twice in the same chat is a no-op.

### DatabaseConfig

```typescript
// apps/api/src/lib/chat/comment-db-config.ts
export const COMMENT_INDEX_DB_CONFIG: DatabaseConfig<typeof commentSchema> = {
    name: 'comment-index',
    currentVersion: 1,
    schema: commentSchema,
    migrations: [{
        version: 1,
        up: (db) => db.run(`
            CREATE TABLE IF NOT EXISTS comments (...);
            CREATE TABLE IF NOT EXISTS comment_mentions (...);
            CREATE INDEX IF NOT EXISTS idx_mentions_email ON comment_mentions(email);
        `)
    }]
};
```

## ChatRoom: Container Discovery

`containerPath` field on `ChatRoom`, resolved during `init()` via `Drive.findContainerPath()`:

```typescript
// apps/api/src/lib/chat/chat.ts
export class ChatRoom {
    private drive: Drive;
    private home: Home;
    private path: DrivePath;
    private containerPath: DrivePath | null = null;
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
}
```

`Drive.findContainerPath()` delegates to the shared `findContainerPath()` in `acl.ts`, which walks the full `parentId`
chain to root and returns the outermost collab ancestor. For the standard eigendoc structure the walk is short
(chat/ folder -> doc -> parent folder -> root). Negligible cost, done once per `ChatRoom.init()`.

## CommentIndex Service

```typescript
// apps/api/src/lib/chat/comment-index.ts
export class CommentIndex {
    private db: BunSQLiteDatabase<typeof commentSchema>;

    constructor(db: BunSQLiteDatabase<typeof commentSchema>) {
        this.db = db;
    }

    async ensureComment(chatName: string): Promise<void> { /* upsert, onConflictDoNothing */
    }

    async updateActivity(chatName: string, authorEmail: string, snippet: string, incrementCount = true): Promise<void> {
        // Updates lastAuthorEmail, lastMessageSnippet (truncated to 100 chars), lastActivityAt.
        // Increments messageCount when incrementCount=true (post). Skips increment on edit (incrementCount=false).
    }

    async addMention(chatName: string, email: string): Promise<void> { /* onConflictDoNothing */
    }

    async resolve(chatName: string, email: string): Promise<void> { /* sets status='resolved' */
    }

    async reopen(chatName: string): Promise<void> { /* sets status='open', clears resolvedBy/At */
    }

    async decrementCount(chatName: string): Promise<void> { /* MAX(0, messageCount - 1) */
    }

    async list() {
        // Returns all comments with inline mentions: string[] array per comment.
        // Loads all comments + all mentions in 2 queries, groups mentions by chatName in memory.
        // No separate mentions endpoint — frontend filters client-side for any user.
    }

    async unresolvedCount(): Promise<number> { /* COUNT(*) WHERE status='open' */
    }
}
```

### Opening `comments.db`

`comments.db` is created by `CollabDocument.create()`, so it always exists:

```typescript
// apps/api/src/lib/chat/comment-index.ts
export async function openCommentIndex(drive: Drive, containerPath: DrivePath): Promise<CommentIndex> {
    const dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) throw new ApiError(404, 'comments.db not found');
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id);
    return new CommentIndex(managed.db);
}

// Convenience: resolves path + opens index. SharedDrive.getPath() enforces read permission.
export async function getCommentIndex(drive: Drive, mountId: string, pathId: string): Promise<CommentIndex> {
    const path = await drive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Container not found');
    return openCommentIndex(drive, path);
}
```

`ManagedDatabase` handles WAL mode, versioning, and caching. No explicit cleanup — registered with Home's DB tracker.

## Updating the Index

All index updates are wrapped in a private `updateCommentIndex(fn)` helper that opens the index, runs the callback,
emits an SSE event, and catches errors (non-fatal — the message is already posted):

```typescript
// apps/api/src/lib/chat/chat.ts
private async
updateCommentIndex(fn
:
(index: CommentIndex) => Promise<void>
)
{
    if (!this.containerPath) return;
    try {
        const index = await openCommentIndex(this.drive, this.containerPath);
        await fn(index);

        const event = buildCommentIndexUpdatedEvent(
            this.containerPath.id, this.path.ownerId, this.path.mountId
        );
        this.home.notify(event);
        this.notifySharedUsers(event);
    } catch (error) {
        console.error('Failed to update comment index:', error);
    }
}
```

### On Message Post

In `ChatRoom.postMessage()`, after the message is inserted and SSE events are sent:

```typescript
if (this.containerPath && type !== 'whisper') {
    await this.updateCommentIndex(async (index) => {
        await index.ensureComment(this.path.name);
        await index.updateActivity(this.path.name, authorEmail, content);
        for (const email of extractMentionedEmails(content)) {
            await index.addMention(this.path.name, email);
        }
    });
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

### On Message Edit

Calls `updateActivity(name, email, content, false)` (no messageCount increment) and re-extracts mentions.

### On Message Delete

Calls `decrementCount()` to decrement messageCount (clamped to 0).

## SSE Notifications

### Comment Index Updates

When `updateCommentIndex()` succeeds, it emits a `CHAT_COMMENT_INDEX_UPDATED` event:

```typescript
// apps/api/src/lib/chat/sse-events.ts
export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEvent {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, {chatId: containerId, ownerId, mountId});
}
```

```typescript
// packages/lib/src/types/sse.ts
CHAT_COMMENT_INDEX_UPDATED: 'chat:comment-index-updated',
```

SSE handler invalidates `commentKeys.container(...)`.

### Notifying Shared Users

`ChatRoom.notifySharedUsers(event)` uses `Drive.getEffectiveMembers()` to resolve all users with access to the chat.
This handles all access scenarios:

- **Direct ACL on the chat** — explicit shares
- **Inherited ACL from parent folders** — chat inside a shared folder
- **Container document ACL** — embedded chat inherits from the doc
- **Team membership** — team ACL entries expanded to individual members
- **Owner** — always included with full permissions

```typescript
private async
notifySharedUsers(event
:
SSEvent
)
{
    const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
    for (const member of members) {
        const user = await getUserByEmail(member.email);
        if (!user) continue;
        try {
            if (atHome(user.id)) {
                const home = await getHome(user.id);
                home.notify(event);
            }
        } catch { /* user home may not exist */
        }
    }
}
```

See [ACL.md](ACL.md) for details on `getEffectiveMembers`.

## API Routes

### Comment Routes (collab.ts)

Added to `apps/api/src/routes/collab.ts` — comments are document-scoped metadata, alongside `/info` and `/revisions`.

```
GET    /collab/:ownerId/:mountId/:pathId/comments                    List all comments (with mentions[] inline)
GET    /collab/:ownerId/:mountId/:pathId/comments/unresolved-count   Unresolved count
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/status   Resolve or reopen
```

All routes use `getCommentIndex(drive, mountId, pathId)` for thin handlers. `SharedDrive.getPath()` enforces read
permission on GET routes. The PATCH route has an explicit `canWrite` check.

### Effective Members Route (drive.ts)

```
GET    /drive/:ownerId/:mountId/path/:pathId/effective-members       All users with effective access
```

Walks the breadcrumb, collects ACL from all ancestors, expands teams via `resolveACLToEmails()`, adds owner,
deduplicates by email (most permissive wins). Returns `{email, read, write}[]`.

Used by `useChatRoom` to resolve room members for embedded chats (where `chatPath.acl` is empty because access is
inherited from the container document).

## Frontend Hooks

```typescript
// packages/lib/src/core/chat/hooks/use-comments.ts
export const commentKeys = {
    all: ['comments'] as const,
    container: (ownerId, mountId, containerId) => [...commentKeys.all, ownerId, mountId, containerId] as const,
    list: (ownerId, mountId, containerId) => [...commentKeys.container(...), 'list'] as const,
    unresolvedCount: (ownerId, mountId, containerId) => [...commentKeys.container(...), 'unresolved-count'] as const,
};

export function useComments(ownerId, mountId, containerId) { /* GET /collab/.../comments */
}

export function useUnresolvedCommentCount(ownerId, mountId, containerId) { /* GET /collab/.../comments/unresolved-count */
}

export function useResolveComment(ownerId, mountId, containerId) { /* PATCH .../comments/:chatName/status */
}

export function invalidateComments(queryClient, ownerId, mountId, containerId) { /* SSE handler calls this */
}
```

```typescript
// packages/lib/src/core/drive/hooks/use-drive.ts
export function useEffectiveMembers(ownerId, mountId, pathId) { /* GET /drive/.../effective-members */
}
```

Mention filtering ("show comments mentioning me") is done client-side by filtering the `mentions: string[]` array
returned inline with each comment from `list()`. This allows filtering by any user, not just the current one.

## Document-Level Integration

Each app passes its container pathId to the comment hooks:

- **Docs**: `path.id` (the eigendoc DrivePath) — already available in `editor.tsx`
- **Stickies**: `path.id` (the eigenstickies DrivePath) — available in board component
- **Slides**: `path.id` — available in editor
- **Sheets**: `path.id` — available in editor

The comment sidebar component (shared in `packages/ui`) receives `ownerId`, `mountId`, `containerId` and renders:

1. **All comments** with status badges (open = yellow dot, resolved = green check)
2. **"Mentions" filter** toggle — filters client-side by current user's email in `mentions[]`
3. **Resolve/Reopen** button per comment
4. **Click** -> opens the comment chat dialog (existing `ViewCommentDialog` or equivalent)

## Active vs Orphaned Comments

When a user deletes a CommentMark in a doc (removes annotation from text) or deletes a card in stickies, the
`.eigenchat` stays on disk and `comments.db` retains the row. This is intentional — the chat is preserved for version
revert and the index is a metadata cache, not an authority on what's live.

**The document structure is the source of truth for which comments are "active":**

- **Docs**: scan Tiptap document for `CommentMark` nodes -> extract `chatName` attributes
- **Stickies**: scan Y.Map cards -> extract cards with `chatName`
- **Slides/Sheets**: same pattern

**Filtering is a frontend concern.** The Yjs document is already loaded in the frontend, so getting the active set is
trivial. The comment sidebar flow:

1. `GET /collab/.../comments` -> returns ALL comments from the index (with `mentions[]` inline)
2. Frontend intersects with active `chatName`s from the Yjs state
3. Show active comments first, optionally show orphaned ones in a collapsed "archived" section

No `archived` status in the schema — that would couple the DB to document format and require Yjs observers on the
server. The `open | resolved` status tracks comment thread state, not whether the anchor exists.

## Integration with Mentions System

The `containerPath` field on `ChatRoom` enables proper deep linking when mention notifications are added:

- **Standalone chat mention** → notification links to chat room
- **Embedded comment mention** → notification links to the container document

The `comment_mentions` table in `comments.db` serves document-scoped filtering ("which comments in this doc mention
me?"). Both mention detection and extraction use `extractMentionedEmails` with `EMAIL_FIND_REGEX` from
`@workspace/lib/validation`. See [TODO-MENTIONS.md](TODO-MENTIONS.md) for the cross-app notification center plan.

## Performance

| Operation                                 | Cost                                                                        |
|-------------------------------------------|-----------------------------------------------------------------------------|
| Container discovery (`findContainerPath`) | ~4 SQLite lookups by PK for standard structure (once per `ChatRoom.init()`) |
| Index update on message post              | 1 DB open (cached by `ManagedDatabase`) + 2-3 INSERTs/UPDATEs               |
| List all comments (with mentions)         | 1 DB open + 2 SELECTs (comments + mentions, grouped in memory)              |
| Resolve/reopen                            | 1 DB open + 1 UPDATE                                                        |
| Effective members                         | Breadcrumb walk + team expansion (cached by query)                          |

The `comments.db` is tiny: rows = number of comments (typically <100 per document). All operations are sub-millisecond.

## Complete File Changes

| File                                                       | Change                                                                                            |
|------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| **New** `apps/api/src/lib/chat/comment-schema.ts`          | Drizzle schema for `comments` + `comment_mentions`                                                |
| **New** `apps/api/src/lib/chat/comment-db-config.ts`       | `COMMENT_INDEX_DB_CONFIG`                                                                         |
| **New** `apps/api/src/lib/chat/comment-index.ts`           | `CommentIndex` class + `openCommentIndex()` + `getCommentIndex()`                                 |
| **New** `apps/api/src/lib/chat/mentions.ts`                | `extractMentionedEmails()`                                                                        |
| **New** `packages/lib/src/core/chat/hooks/use-comments.ts` | Query hooks + keys + `invalidateComments()`                                                       |
| `apps/api/src/lib/chat/chat.ts`                            | `containerPath`, `updateCommentIndex()` helper, `notifySharedUsers()` via `getEffectiveMembers()` |
| `apps/api/src/lib/chat/sse-events.ts`                      | `buildCommentIndexUpdatedEvent()`                                                                 |
| `apps/api/src/lib/collab/collabDocument.ts`                | `comments.db` creation in `CollabDocument.create()`                                               |
| `apps/api/src/lib/drive/acl-propagation.ts`                | `EffectiveMember` type + `resolveACLToEmails()`                                                   |
| `apps/api/src/lib/drive/drive.ts`                          | `getEffectiveMembers()`                                                                           |
| `apps/api/src/lib/drive/sharedDrive.ts`                    | `getEffectiveMembers()` + `getChildByName()` overrides                                            |
| `apps/api/src/routes/collab.ts`                            | Comment list/unresolved-count/status routes                                                       |
| `apps/api/src/routes/drive.ts`                             | Effective members route                                                                           |
| `packages/lib/src/types/sse.ts`                            | `CHAT_COMMENT_INDEX_UPDATED`                                                                      |
| `packages/lib/src/core/api.ts`                             | `collabApi` export                                                                                |
| `packages/lib/src/core/chat/sse-handlers.ts`               | `CHAT_COMMENT_INDEX_UPDATED` handler                                                              |
| `packages/lib/src/core/drive/hooks/use-drive.ts`           | `useEffectiveMembers()` hook                                                                      |

