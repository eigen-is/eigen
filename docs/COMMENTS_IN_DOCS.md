# Comments in Documents

> **TLDR**: Each container document (eigendoc/stickies/slides/sheets) has a `comments.db` that indexes embedded
> comment chats. Enables fast mention filtering, comment resolution status, and activity summaries — without opening N
> individual chat databases. `ChatRoom` discovers its container during `init()` by walking up the `parentId` chain.
> Updates to `comments.db` happen server-side via `ChatRoom.updateCommentIndex()`. Mentions are returned inline with
> the comment list (no separate endpoint).

## How a Chat Knows It's Embedded

A chat does **not** inherently know. `ChatRoom` receives a `DrivePath` during construction. The `DrivePath` has a
`parentId` field. By walking up the parent chain via `Drive.getPath()`, the server determines if the chat lives inside
a container document. The chain for an embedded comment is always:
`eigenchat -> chat/ folder -> container document`.

For a standalone chat (top-level `.eigenchat` in Drive), the parent chain goes directly to a regular folder or root —
no collab type ancestor is found.

`CollabDocument.create()` creates the standard structure — including `comments.db`, a `media/` folder, and a `chat/`
folder — so every container document has these from birth.

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

## ChatRoom: Container Discovery

`containerPath` field on `ChatRoom`, resolved during `init()` via `Drive.findContainerPath()`. This delegates to the
shared `findContainerPath()` in `acl.ts`, which walks the full `parentId` chain to root and returns the outermost
collab ancestor. For the standard eigendoc structure the walk is short (chat/ folder -> doc -> parent folder -> root).
Negligible cost, done once per `ChatRoom.init()`.

## CommentIndex Service

`CommentIndex` (`apps/api/src/lib/chat/comment-index.ts`) wraps `comments.db` with these operations:

| Method              | Description                                                                       |
|---------------------|-----------------------------------------------------------------------------------|
| `ensureComment`     | Upsert a comment row (`onConflictDoNothing`)                                      |
| `updateActivity`    | Update `lastAuthorEmail`, `lastMessageSnippet` (truncated 100 chars), `lastActivityAt`. Optionally increments `messageCount` |
| `addMention`        | Insert mention row (`onConflictDoNothing`)                                        |
| `resolve`           | Set `status='resolved'`, record `resolvedBy`/`resolvedAt`                         |
| `reopen`            | Set `status='open'`, clear `resolvedBy`/`resolvedAt`                              |
| `decrementCount`    | `MAX(0, messageCount - 1)`                                                        |
| `list`              | Returns all comments with inline `mentions: string[]` per comment (2 queries, grouped in memory) |
| `unresolvedCount`   | `COUNT(*) WHERE status='open'`                                                    |

Helper functions `openCommentIndex(drive, containerPath)` and `getCommentIndex(drive, mountId, pathId)` handle path
resolution and DB opening. `ManagedDatabase` handles WAL mode, versioning, and caching.

## Updating the Index

All index updates go through `ChatRoom.updateCommentIndex(fn)`, which opens the index, runs the callback, emits a
`CHAT_COMMENT_INDEX_UPDATED` SSE event, and catches errors (non-fatal — the message is already posted).

| Trigger                 | Index operations                                                                      |
|-------------------------|---------------------------------------------------------------------------------------|
| **Message post**        | `ensureComment` + `updateActivity` (with increment) + `addMention` for each extracted email |
| **Comment chat creation** | No separate hook — first message post triggers `ensureComment` upsert               |
| **Message edit**        | `updateActivity` (no increment) + re-extract mentions                                 |
| **Message delete**      | `decrementCount`                                                                      |

Mention extraction uses `extractMentionedEmails()` (`apps/api/src/lib/chat/mentions.ts`) with `EMAIL_FIND_REGEX` from
`@workspace/lib/validation`.

## SSE Notifications

When `updateCommentIndex()` succeeds, it emits `CHAT_COMMENT_INDEX_UPDATED` (`chat:comment-index-updated`).
The SSE handler invalidates `commentKeys.container(...)`.

`ChatRoom.notifySharedUsers(event)` uses `Drive.getEffectiveMembers()` to resolve all users with access to the chat
(direct ACL, inherited ACL from parents, team membership, owner). See [ACL.md](ACL.md) for details on
`getEffectiveMembers`.

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

All hooks live in `packages/lib/src/core/chat/hooks/use-comments.ts`.

| Hook / export                | Description                                       |
|------------------------------|---------------------------------------------------|
| `commentKeys`                | Query key factory: `all`, `container`, `list`, `unresolvedCount` |
| `useComments`                | `GET /collab/.../comments` — list with inline mentions |
| `useUnresolvedCommentCount`  | `GET /collab/.../comments/unresolved-count`        |
| `useResolveComment`          | `PATCH .../comments/:chatName/status`              |
| `invalidateComments`         | Called by SSE handler to invalidate container keys  |
| `useEffectiveMembers`        | In `use-drive.ts` — `GET /drive/.../effective-members` |

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

- **Standalone chat mention** -> notification links to chat room
- **Embedded comment mention** -> notification links to the container document

The `comment_mentions` table in `comments.db` serves document-scoped filtering ("which comments in this doc mention
me?"). See [TODO-MENTIONS.md](TODO-MENTIONS.md) for the cross-app notification center plan.

## Performance

| Operation                                 | Cost                                                                        |
|-------------------------------------------|-----------------------------------------------------------------------------|
| Container discovery (`findContainerPath`) | ~4 SQLite lookups by PK for standard structure (once per `ChatRoom.init()`) |
| Index update on message post              | 1 DB open (cached by `ManagedDatabase`) + 2-3 INSERTs/UPDATEs               |
| List all comments (with mentions)         | 1 DB open + 2 SELECTs (comments + mentions, grouped in memory)              |
| Resolve/reopen                            | 1 DB open + 1 UPDATE                                                        |
| Effective members                         | Breadcrumb walk + team expansion (cached by query)                          |

The `comments.db` is tiny: rows = number of comments (typically <100 per document). All operations are sub-millisecond.

## Key Files

| File                                                       | Purpose                                            |
|------------------------------------------------------------|----------------------------------------------------|
| `apps/api/src/lib/chat/comment-schema.ts`                  | Drizzle schema for `comments` + `comment_mentions`  |
| `apps/api/src/lib/chat/comment-db-config.ts`               | `COMMENT_INDEX_DB_CONFIG`                           |
| `apps/api/src/lib/chat/comment-index.ts`                   | `CommentIndex` class + open/get helpers             |
| `apps/api/src/lib/chat/mentions.ts`                        | `extractMentionedEmails()`                          |
| `apps/api/src/lib/chat/chat.ts`                            | `containerPath`, `updateCommentIndex()`, `notifySharedUsers()` |
| `apps/api/src/lib/chat/sse-events.ts`                      | `buildCommentIndexUpdatedEvent()`                   |
| `apps/api/src/routes/collab.ts`                            | Comment list/status routes                          |
| `apps/api/src/routes/drive.ts`                             | Effective members route                             |
| `packages/lib/src/core/chat/hooks/use-comments.ts`         | Query hooks + keys + `invalidateComments()`         |
| `packages/lib/src/core/drive/hooks/use-drive.ts`           | `useEffectiveMembers()` hook                        |
