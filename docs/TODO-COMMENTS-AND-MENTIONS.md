# Comments, Mentions & ACL Bubbling

> **TLDR**: Two related problems — (1) ACL changes on embedded chats should bubble up to the container document, and
> (2) we need a comment index for fast "where am I mentioned" filtering, @mentions in comment chats, and comment
> resolution status. Solution: a `findACLTarget()` utility for ACL bubbling, and a `comments.db` per container document
> for comment metadata indexing.

## 1. Problem Analysis

### 1.A Current State

Chats are used as comments inside docs and stickies, and will expand to slides and sheets:

```
my-doc.eigendoc/
├── data.db              (Yjs)
├── media/
└── chat/
    ├── General.eigenchat/
    └── comment-1710523456.eigenchat/
```

References are name-based (see MEDIA-REFERENCES.md):
- **Docs**: `CommentMark` Tiptap extension stores `chatName` attribute → resolved via `MediaResolverProvider`
- **Stickies**: `CardItem.chatName` field in Yjs → same resolution pattern
- **Slides/Sheets**: will follow the same pattern

ACL is inherited from Drive. Chat rooms have no separate membership — ACL *is* membership (see TODO-CHAT-ACL.md).

### 1.B Problem 1: ACL on Embedded Chats

When you `/invite alice@example.com` in a comment chat inside an eigendoc:

1. Frontend (`use-chat-room.ts` line 128-134) reads `chatPath.acl`, appends the new entry, calls `updateACL` on the
   **chat's** DrivePath
2. Alice gets ACL on `comment-1710523456.eigenchat` — but NOT on `my-doc.eigendoc`
3. Alice can read the chat messages but cannot open the document that contains it
4. The same happens via the share dialog if opened on the chat directly

This is broken for embedded chats. The ACL should be set on the container document so the invited user can actually
access the context.

### 1.C Problem 2: No Comment Metadata

When opening a document, there's no way to know:

- **Which comments mention me** — would require opening every `*.eigenchat/data.db` inside `chat/`, scanning all
  messages for email patterns. O(N) database opens, unacceptable
- **Which comments are resolved vs open** — no status field exists anywhere
- **Comment activity summary** — no message count, last activity, or snippet without opening each chat DB

This makes comments unusable at scale. A document with 20 comments would need 20 SQLite database opens just to show a
sidebar.

## 2. Proposal: ACL Bubbling

### 2.A Core Idea

When ACL is changed on any path that lives *inside* a container document (eigendoc, eigenstickies, eigenslides,
eigensheets), find the outermost container document in the ancestor chain and apply the ACL change there instead.

### 2.B `findACLTarget()` — Server-Side Utility

```typescript
// apps/api/src/lib/drive/acl.ts
async function findACLTarget(
    mount: Mount,
    startPathId: string
): Promise<DrivePath> {
    let current = await mount.getPath(startPathId);
    if (!current) throw new ApiError(404, 'Path not found');

    let target = current;

    while (current.parentId) {
        const parent = await mount.getPath(current.parentId);
        if (!parent) break;
        if (isCollabType(parent.type)) {
            target = parent;
        }
        current = parent;
    }

    return target;
}
```

Walk: `comment-1.eigenchat` → `chat/` (folder) → `my-doc.eigendoc` (doc, **collab type → target**) →
`Projects/` (folder) → root. Returns `my-doc.eigendoc`.

For standalone chats: `my-chat.eigenchat` → `Projects/` (folder) → root. No collab ancestor found, returns
`my-chat.eigenchat` itself. Preserves current behavior.

### 2.C Integration Point

Modify `Drive.updateACL()` to call `findACLTarget()` before applying:

```typescript
// apps/api/src/lib/drive/drive.ts — updateACL()
async updateACL(mountId: string, pathId: string, acl: DriveACL[] | null, visibility?: DriveVisibility): Promise<void> {
    const mount = this.getMount(mountId);

    // Redirect ACL to container document if path is inside one
    const target = await findACLTarget(mount, pathId);
    const effectivePathId = target.id;

    // ... rest of updateACL using effectivePathId instead of pathId
}
```

This means:
- `/invite` in embedded chats → ACL set on container document automatically
- Share dialog on embedded content → same redirection
- Share dialog on standalone chats → no change
- Share dialog on documents directly → no change (already the target)

### 2.D Permission Check

`updateACL` checks `canWrite(mountId, pathId, owner)`. With redirection, it checks write on the *container document*.
This is correct: if you can write to the embedded chat (inherited from the document), you can also write to the
document. The reverse edge case — someone with explicit chat-only ACL but not document ACL — doesn't occur in practice
because embedded chats inherit from their container.

If it did occur (manual DB tampering), the 403 error is the right response: you shouldn't be able to grant document
access if you don't have document access yourself.

### 2.E Frontend Changes

The frontend `/invite` handler in `use-chat-room.ts` currently builds ACL from `chatPath.acl`. After redirection, the
server applies ACL to the container document, but the frontend doesn't know this. Two options:

**Option A — Server handles everything (recommended)**: Create a new API endpoint specifically for inviting users to a
chat context:

```
POST /chat/:ownerId/:mountId/:chatId/invite
body: { email: string }
```

The server resolves the container, checks permissions, updates ACL, and returns the updated path. The frontend
`/invite` handler calls this instead of `useUpdateACL`. Clean separation: frontend doesn't need to know about container
resolution.

**Option B — Frontend resolves container**: Frontend walks the breadcrumb to find the container and calls `updateACL` on
it. Fragile — duplicates server logic on the client, and the breadcrumb API may not return internal paths.

### 2.F Edge Cases & Concerns

- **Standalone chats**: `findACLTarget` returns self → no behavior change
- **Top-level container already has the ACL entry**: `filterRedundantACL` strips it → no-op, correct
- **Nested containers**: Can't happen (can't put an eigendoc inside an eigendoc), but `findACLTarget` handles it by
  returning the outermost one
- **Performance**: Walking the parent chain is 2-4 hops for embedded content. Each hop is a single SQLite lookup by
  primary key. Negligible
- **Visibility setting**: If the caller sets `visibility: 'public-read'` on an embedded chat, should that bubble up to
  the container? **Yes** — same reasoning as ACL. A public chat inside a private doc is nonsensical
- **Breaking change**: Existing embedded chats with direct ACL entries will still work (ACL is additive, inherited from
  ancestors). New ACL changes will target the container. No migration needed

### 2.G Honest Critique

**Risk**: This changes the semantics of `updateACL` globally. Any code that calls `updateACL` on a path inside a
container will be silently redirected. This is usually correct, but if we ever want fine-grained per-chat permissions
inside a document, this blocks it.

**Mitigation**: Add an optional `skipContainerRedirect: boolean` parameter to `updateACL`. Default `false`. Escape hatch
for future use.

**Alternative considered — frontend-only fix**: Just change the `/invite` handler to resolve the parent. Simpler, but
only fixes one entry point. The share dialog, API calls, and any future ACL mutation would still have the same bug.
Server-side is more robust.

## 3. Proposal: Comment Index

### 3.A Core Idea

Add a `comments.db` SQLite database to each container document's root folder. This is a denormalized index of all
embedded comment chats — their status, mentions, and activity summary. Queried once when opening a document.

```
my-doc.eigendoc/
├── data.db              (Yjs)
├── media/
├── chat/
│   ├── comment-1.eigenchat/
│   └── comment-2.eigenchat/
└── comments.db          ← NEW: comment metadata index
```

### 3.B Schema

```sql
-- Comment metadata (one row per embedded chat used as a comment)
CREATE TABLE comments (
    chatName TEXT PRIMARY KEY,          -- eigenchat folder name (matches CommentMark.chatName)
    status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
    resolvedBy TEXT,                     -- email of who resolved it
    resolvedAt INTEGER,                  -- unix timestamp
    lastAuthorEmail TEXT,                -- most recent message author
    lastMessageSnippet TEXT,             -- first 100 chars of last message
    lastActivityAt INTEGER,              -- unix timestamp of last message
    messageCount INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Normalized mention index (one row per user per comment)
CREATE TABLE comment_mentions (
    chatName TEXT NOT NULL,
    email TEXT NOT NULL,
    PRIMARY KEY (chatName, email),
    FOREIGN KEY (chatName) REFERENCES comments(chatName)
);
CREATE INDEX idx_mentions_email ON comment_mentions(email);
```

### 3.C Usage Patterns

**"Where am I mentioned" filter** (when opening a document):

```sql
SELECT c.* FROM comments c
JOIN comment_mentions m ON c.chatName = m.chatName
WHERE m.email = ?
ORDER BY c.lastActivityAt DESC
```

One query, one database open. Returns all comments that mention the current user with their status and activity summary.

**Comment sidebar** (list all comments with status):

```sql
SELECT * FROM comments ORDER BY createdAt ASC
```

**Unresolved count badge**:

```sql
SELECT COUNT(*) FROM comments WHERE status = 'open'
```

### 3.D Keeping the Index Updated

The index is updated at two points:

**1. When a message is posted to an embedded chat** — in `ChatRoom.postMessage()`:

```typescript
// After inserting the message, update the container's comment index
const container = await findACLTarget(mount, this.path.id);
if (container.id !== this.path.id) {
    // This chat is embedded — update comment index
    const commentsDb = await openCommentsDb(drive, container);
    await commentsDb.updateActivity(this.path.name, {
        lastAuthorEmail: authorEmail,
        lastMessageSnippet: content.slice(0, 100),
        lastActivityAt: Date.now(),
        messageCount: increment,
    });

    // Extract and index mentions
    const mentionedEmails = extractMentionedEmails(content);
    for (const email of mentionedEmails) {
        await commentsDb.addMention(this.path.name, email);
    }
}
```

**2. When a comment chat is created** — in `CreateCommentDialog` flow (the route that creates the chat):

```typescript
// After creating the eigenchat, insert a row into comments.db
const commentsDb = await openCommentsDb(drive, containerPath);
await commentsDb.createComment(newChatPath.name);
```

**3. When a comment is resolved/reopened** — new API endpoint:

```
PATCH /chat/:ownerId/:mountId/:chatId/status
body: { status: 'resolved' | 'open' }
```

### 3.E CommentIndex Service

```typescript
// apps/api/src/lib/chat/comment-index.ts
export class CommentIndex {
    private db: BunSQLiteDatabase<typeof commentSchema>;

    async createComment(chatName: string): Promise<void> { /* INSERT */ }

    async updateActivity(chatName: string, data: {
        lastAuthorEmail: string;
        lastMessageSnippet: string;
        lastActivityAt: number;
        messageCount?: 'increment';
    }): Promise<void> { /* UPDATE + INCREMENT messageCount */ }

    async addMention(chatName: string, email: string): Promise<void> {
        /* INSERT OR IGNORE into comment_mentions */
    }

    async resolve(chatName: string, email: string): Promise<void> {
        /* UPDATE status = 'resolved', resolvedBy, resolvedAt */
    }

    async reopen(chatName: string): Promise<void> {
        /* UPDATE status = 'open', resolvedBy = NULL, resolvedAt = NULL */
    }

    async listComments(): Promise<Comment[]> { /* SELECT * ORDER BY createdAt */ }

    async getMentionsForUser(email: string): Promise<Comment[]> {
        /* JOIN query from 3.C */
    }

    async getUnresolvedCount(): Promise<number> { /* COUNT where open */ }
}
```

### 3.F Opening `comments.db`

The `comments.db` lives inside the container document's Drive folder. It's opened the same way chat databases are —
via `Drive.openDatabase()`. A helper function resolves it:

```typescript
async function openCommentsDb(
    drive: Drive,
    containerPath: DrivePath
): Promise<CommentIndex> {
    let dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) {
        await drive.touchFile(containerPath.mountId, containerPath.id, 'comments.db', 'application/x-sqlite3');
        dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    }
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath!.id);
    return new CommentIndex(managed.db);
}
```

### 3.G API Routes

```
GET    /chat/:ownerId/:mountId/:containerId/comments          — list all comments with status
GET    /chat/:ownerId/:mountId/:containerId/comments/mentions  — comments mentioning current user
GET    /chat/:ownerId/:mountId/:containerId/comments/count     — unresolved count
PATCH  /chat/:ownerId/:mountId/:chatId/status                  — resolve/reopen
POST   /chat/:ownerId/:mountId/:chatId/invite                  — invite user (ACL bubbling)
```

### 3.H Frontend: Comment Sidebar / Mention Filter

Each app (docs, stickies, slides, sheets) can show a comment panel with:

- **All comments** tab: list from `comments.db`, showing status badge (open/resolved), last message snippet, timestamp
- **Mentions** tab: filtered to comments where current user is mentioned
- **Resolve button**: on each comment, toggles status

This requires one API call on document open — not N database opens.

### 3.I @Mentions in Comment Chats

Mentions in chat messages use the existing `@` autocomplete (`ChatPlayerSuggest`). The detection is simple:

```typescript
// Reuse from RESEARCH_MENTIONS.md
const EMAIL_REGEX = /(?:^|[\s,.])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=[\s,.]|$)/g;

export function extractMentionedEmails(content: string): string[] {
    const emails: string[] = [];
    let match;
    while ((match = EMAIL_REGEX.exec(content)) !== null) {
        emails.push(match[1].toLowerCase());
    }
    return [...new Set(emails)];
}
```

When `ChatRoom.postMessage()` detects mentions in an embedded chat, it:
1. Indexes them in `comments.db` → `comment_mentions` table
2. Creates notifications via the notification system (RESEARCH_MENTIONS.md Phase 2)

Both are independent — the index enables fast filtering, notifications enable real-time alerts.

### 3.J Honest Critique

**Risk: Stale index.** The `comments.db` is a denormalized cache. If a message is edited or deleted, the index may
show stale snippets or mention counts. Mitigation: update the index on edit/delete too, or accept eventual consistency
(mention filter showing a stale snippet is low-impact).

**Risk: Index not created for existing documents.** Old eigendocs won't have `comments.db`. Mitigation:
`openCommentsDb` creates it on first access. Old comments won't be indexed until new activity occurs. A one-time
backfill script could scan existing chat folders and populate the index.

**Risk: Additional DB open per message post.** Every message in an embedded chat now opens `comments.db` to update the
index. Mitigation: `comments.db` is tiny (rows = number of comments, typically <100). SQLite opens are ~1ms. The
`ManagedDatabase` caching may keep it warm.

**Alternative considered — Yjs attribute for resolved status.** Adding `resolved: boolean` to `CommentMark` in Tiptap.
Pros: collaborative, no extra DB. Cons: only works for docs (not stickies/slides/sheets), doesn't help with mention
indexing, doesn't provide activity summary. Rejected in favor of the uniform `comments.db` approach.

**Alternative considered — metadata JSON file.** A `chat/metadata.json` instead of `comments.db`. Pros: simple.
Cons: not atomic (concurrent writes corrupt it), no query capabilities, no indexing. Rejected.

**Alternative considered — central mentions table in user's Home.** Like the notification DB. Pros: per-user, fast.
Cons: doesn't answer "which comments in THIS document mention me" without cross-referencing. The `comments.db`
approach is document-scoped, which matches the use case perfectly.

**Alternative considered — metadata in the chat's own data.db.** Add a `meta` table to each eigenchat. Cons: still
requires opening N databases to build the document-level view. Doesn't solve the core problem.

## 4. Uniform Comment Pattern Across Apps

### 4.A Container Structure (All Apps)

Every container document type follows the same layout:

```
my-thing.eigen{doc,stickies,slides,sheets}/
├── data.db              (Yjs or app-specific)
├── media/               (embedded images/files)
├── chat/                (comment chats)
│   ├── comment-*.eigenchat/
│   └── ...
└── comments.db          (comment metadata index)
```

### 4.B Comment References by App

| App       | Where comment reference is stored | Reference field         | How it's created                        |
|-----------|-----------------------------------|-------------------------|-----------------------------------------|
| Docs      | Tiptap CommentMark               | `chatName` attribute    | Select text → "Add Comment" → dialog    |
| Stickies  | Card Y.Map                        | `chatName` field        | Card menu → "Add Comment"               |
| Slides    | SlideObject Y.Map (new)           | `chatName` field        | Right-click object → "Add Comment"      |
| Sheets    | Cell metadata (new)               | `chatName` field        | Right-click cell → "Add Comment"        |

All resolve via `MediaResolverProvider.resolveChatId(chatName)` — existing pattern.

### 4.C Comment Lifecycle

```
Create:  UI action → create eigenchat in chat/ → insert into comments.db → store chatName in Yjs
Post:    User posts in comment chat → update comments.db activity + mentions
Resolve: User clicks "Resolve" → PATCH status → update comments.db
Reopen:  User clicks "Reopen" → PATCH status → update comments.db
Delete:  User removes comment mark → soft-delete in comments.db (chat folder persists)
```

## 5. Implementation Plan

### Phase 1: ACL Bubbling (Small, Isolated)

- Add `findACLTarget()` to `apps/api/src/lib/drive/acl.ts`
- Integrate into `Drive.updateACL()` with `skipContainerRedirect` escape hatch
- Add `POST /chat/:ownerId/:mountId/:chatId/invite` endpoint
- Update `use-chat-room.ts` `/invite` handler to use new endpoint
- Test: invite in embedded chat → ACL on container document

### Phase 2: Comment Index Infrastructure

- Create `apps/api/src/lib/chat/comment-index.ts` (CommentIndex service)
- Create `apps/api/src/lib/chat/comment-schema.ts` (Drizzle schema)
- Create `apps/api/src/lib/chat/comment-db-config.ts` (DatabaseConfig)
- Add `openCommentsDb()` helper
- Add comment metadata API routes
- Update `ChatRoom.postMessage()` to update index for embedded chats
- Update comment creation flow to insert into index

### Phase 3: Comment Resolution

- Add resolve/reopen API endpoint
- Add resolution UI to comment dialogs (docs first, then stickies)
- Add resolved visual state to CommentMark rendering (strikethrough or muted highlight)

### Phase 4: Mention Indexing

- Add `extractMentionedEmails()` to `ChatRoom.postMessage()` for embedded chats
- Index mentions in `comment_mentions` table
- Add "Mentions" API endpoint
- Add mention filter UI to comment sidebar

### Phase 5: Comment Sidebar UI

- Shared `CommentSidebar` component in `packages/ui`
- Integrate into docs, stickies, slides, sheets
- Show comment list with status, activity, mention filter

### Phase 6: Slides & Sheets Comments

- Add `chatName` field to SlideObject Y.Map
- Add cell comment metadata to sheets
- Create chat/ folder structure for slides and sheets
- Wire up comment creation/viewing using shared components

## 6. Files Reference

| Category              | File                                                          | Relevance                                    |
|-----------------------|---------------------------------------------------------------|----------------------------------------------|
| **ACL core**          | `apps/api/src/lib/drive/acl.ts`                               | Add `findACLTarget()`                        |
| **ACL update**        | `apps/api/src/lib/drive/drive.ts`                             | Modify `updateACL()` to use `findACLTarget`  |
| **ACL propagation**   | `apps/api/src/lib/drive/acl-propagation.ts`                   | `resolveACLUserIds()`, `propagateACLChange()` |
| **Chat room**         | `apps/api/src/lib/chat/chat.ts`                               | Modify `postMessage()` to update index       |
| **Chat hook**         | `packages/lib/src/core/chat/hooks/use-chat-room.ts`           | Modify `/invite` to use new endpoint         |
| **Chat routes**       | `apps/api/src/routes/chat.ts`                                 | Add invite + status + comments endpoints     |
| **Drive types**       | `packages/lib/src/types/drive.ts`                             | `isCollabType()` used by `findACLTarget`     |
| **Comment mark**      | `apps/docs/src/components/docs/extensions/comment-mark.ts`    | Add resolved visual state                    |
| **Comment dialog**    | `apps/docs/src/components/docs/comment-dialog.tsx`            | Update to insert into comments.db            |
| **Media resolver**    | `packages/lib/src/core/drive/media-resolver.tsx`              | Already resolves chatName → chatId           |
| **Mention extraction**| `packages/lib/src/validation/email.ts`                        | `EMAIL_FIND_REGEX` already exists            |
