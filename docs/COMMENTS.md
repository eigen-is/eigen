# Comments

> **TLDR**: Per-document comment system using embedded eigenchats with a SQLite index (`comments.db`) for fast
> listing, mention filtering, and resolution tracking. Frontend: shared `CommentPanel` (PropertiesPanel overlay),
> `CommentThread` (ChatMessageList + ChatMessageInput), and `NoteCard` components in `packages/ui`. ProseMirror
> decorations handle highlight colors and resolved state in the docs editor.

## Architecture

```
Backend: ChatRoom.updateCommentIndex() → comments.db (SQLite index per container document)
Frontend: useComments() → CommentPanel (shared UI) + ProseMirror decorations (doc-specific)
```

Each container document (eigendoc, eigenstickies, eigenslides, eigensheets) stores a `comments.db` alongside
`data.db`. Comment chats live as `.eigenchat` folders in the container's `chat/` directory.

```
my-doc.eigendoc/
├── data.db              (Yjs collaborative state)
├── comments.db          (comment metadata index)
├── media/
└── chat/
    ├── comment-1.eigenchat/
    └── comment-2.eigenchat/
```

## Database Schema

**`comments` table** (`apps/api/src/lib/chat/comment-schema.ts`):
`chatName` (PK), `status` (open|resolved), `resolvedBy`, `resolvedAt`, `lastAuthorEmail`, `lastMessageSnippet`,
`lastActivityAt`, `messageCount`, `createdAt`, `color`

**`comment_mentions` table**: `chatName` + `email` (composite PK). Normalized mention index for per-document
"comments mentioning me" filtering.

## CommentIndex Service

`CommentIndex` (`apps/api/src/lib/chat/comment-index.ts`) wraps `comments.db`:

| Method           | Description                                                              |
|------------------|--------------------------------------------------------------------------|
| `ensureComment`  | Upsert comment row                                                       |
| `updateActivity` | Update last author/snippet/activity, optionally increment `messageCount` |
| `addMention`     | Insert mention row (dedup via composite PK)                              |
| `resolve`        | Set `status='resolved'`, record `resolvedBy`/`resolvedAt`                |
| `reopen`         | Set `status='open'`, clear resolved fields                               |
| `decrementCount` | `MAX(0, messageCount - 1)`                                               |
| `updateColor`    | Set highlight color for a comment                                        |
| `list`           | All comments with inline `mentions[]` (2 queries, grouped in memory)     |

All updates go through `ChatRoom.updateCommentIndex(fn)`, which opens the index, runs the callback, and emits
`CHAT_COMMENT_INDEX_UPDATED` SSE.

## API Routes (`apps/api/src/routes/collab.ts`)

```
GET    /collab/:ownerId/:mountId/:pathId/comments                    List all comments (with mentions[])
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/status   Resolve or reopen
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/color    Set highlight color (hex or null)
```

## Frontend Hooks (`packages/lib/src/core/chat/hooks/use-comments.ts`)

| Hook / export           | Description                                            |
|-------------------------|--------------------------------------------------------|
| `commentKeys`           | Query key factory: `all`, `container`, `list`          |
| `useComments`           | `GET .../comments` — returns `CommentEntry[]`          |
| `useResolveComment`     | `PATCH .../comments/:chatName/status`                  |
| `useUpdateCommentColor` | `PATCH .../comments/:chatName/color`                   |
| `invalidateComments`    | Called by SSE handler to invalidate container keys      |

## Shared UI Components

### NoteCard (`packages/ui/src/components/layout/notes/`)

Shared card component used by both stickies and comments. Renders a colored card with title, description,
status icon, and reply count. Also provides `NoteCardContextMenu` (edit, color, resolve/reopen, delete) and
`NoteCardDialog` (dialog shell with title/description + children slot for chat thread).

### CommentPanel (`packages/ui/src/components/layout/comments/comment-panel.tsx`)

Properties-panel overlay showing all comments for a document. Uses the same `PropertiesPanel` container and
slide-in animation as the figure/table panels in the docs editor.

- **Tabs**: All / For you (filtered by `mentions[]` containing current user's email)
- **Status filter**: Open (default) / Resolved / All
- **Cards**: `NoteCard` per comment with anchor text, author, status icon, reply count
- Accepts `activeCommentIds` (Set) and `anchorTexts` (Map) from the host app

### CommentThread (`packages/ui/src/components/layout/comments/comment-thread.tsx`)

Single comment thread: resolves `chatName` to `chatId` via `useMediaResolver`, renders `ChatMessageList` +
`ChatMessageInput`. Used inside `NoteCardDialog` when viewing a comment.

### CreateCommentDialog (`packages/ui/src/components/layout/comments/create-comment-dialog.tsx`)

Shared dialog for creating a new comment. Shows a text preview of the anchor (selected text or object
description), a textarea for the comment, and creates the `.eigenchat` folder + first message on submit.
Used by both docs and slides editors.

## Docs Editor Integration

### Active Comments

`useActiveComments(editor)` in `editor.tsx` walks the ProseMirror doc (debounced 200ms) to extract:
- `ids: Set<string>` — all `chatName` values from `CommentMark` marks
- `anchorTexts: Map<string, string>` — first 100 chars of highlighted text per comment

### Comment Panel State

The comment panel is user-toggled (`commentPanelOpen` state), independent of the selection-driven
`sidebarContext` (figure/table). When open, it takes priority over figure/table panels:

```tsx
const activePanel = commentPanelOpen ? 'comments' : sidebarContext;
const showSidebar = isWide && (activePanel === 'comments' || (access.canWrite && activePanel !== 'document'));
```

### ProseMirror Decorations (`comment-mark.ts`)

Two plugins:
1. **commentInteraction** — click handler (open comment dialog), contextmenu handler (comment context menu on
   right-click, "Add comment" on text selection right-click)
2. **commentDecorations** — inline decorations that apply `background-color` from the comment's color field.
   Resolved comments get no decoration (default CSS applies). Updated via `updateCommentDecorations()` which
   writes to extension storage and dispatches a metadata transaction.

### Keyboard Shortcut

`Cmd+Alt+M` — with text selected: opens "Add comment" dialog. Without selection: toggles the comment panel.

### Toolbar

The comment icon in `EditorToolbar` toggles the panel. An unresolved-count badge overlays the button.
Right-click context menus are provided via `NoteCardContextMenu` for comment actions (edit, color,
resolve/reopen, delete mark).

## Slides Editor Integration

### Anchoring

Slides don't use Tiptap/ProseMirror, so comments anchor to **slide objects** instead of text ranges. Each
`SlideObject` has an optional `commentChatNames: string[]` stored as a plain JSON array in the Yjs map.
One comment per object (enforced in UI, not data model). Comment mutations use `'comment'` transaction
origin to exclude them from the Yjs UndoManager.

### Active Comments

`useActiveComments(deck)` in `hooks/use-active-comments.ts` scans all objects for `commentChatNames`,
returning `{ ids: Set<string>, anchorTexts: Map<string, string> }`. Anchor text is the first 100 chars
of text objects or `"Image"` for image objects.

### Visual Indicator

Objects with unresolved comments show a colored corner triangle (top-right, CSS border trick). Clicking
the indicator opens the thread dialog. Resolved comments have no indicator.

### Context Menu

Right-click an object without a comment: "Add comment" item. With a comment: View, Color (submenu with
palette), Resolve/Reopen, Delete actions shown directly (no nested submenu).

### Panel

The `CommentPanel` replaces the properties/background panel when toggled via the toolbar button.
Clicking a comment card navigates to the slide containing the commented object and selects it.

## Sheets Editor Integration

### Anchoring

Sheets anchor comments to **cells** via `commentChatNames?: string[]` on the fortune-sheet `Cell` type.
The fortune-sheet built-in comment system (`ps` field, `NotationBoxes`, comment module, mouse handlers)
has been fully removed and replaced with the shared Eigen comment infrastructure.

### Active Comments

`useActiveComments(flowdata)` in `hooks/use-active-comments.ts` scans the current sheet's cell matrix
for cells with `commentChatNames`, returning `{ ids, anchorTexts }`. Anchor text is the cell reference
(e.g., `"Cell A1"`).

### Visual Indicator

The fortune-sheet canvas draws a red triangle (`#FC6666`) in the top-right corner of any cell with
`commentChatNames.length > 0`. This is built into the canvas rendering layer.

### Context Menu

Fortune-sheet's cell context menu has a `"comment"` item rendered via hooks:
- No comment: "Add comment" (calls `hooks.onAddComment`)
- Has comment: "View comment" / "Delete comment" (calls `hooks.onViewComment` / `hooks.onDeleteComment`)

### Panel

`CommentPanel` shows as a sidebar alongside the spreadsheet when toggled via the toolbar button.

## Active vs Orphaned Comments

The Yjs document is the source of truth for which comments are "active". When a user deletes a `CommentMark`,
the `.eigenchat` and `comments.db` row persist (for version revert). The frontend intersects `useComments()`
results with `activeCommentIds` from the doc to show only live comments.

## Key Files

| File                                                          | Purpose                                   |
|---------------------------------------------------------------|-------------------------------------------|
| `apps/api/src/lib/chat/comment-schema.ts`                    | Drizzle schema                            |
| `apps/api/src/lib/chat/comment-db-config.ts`                 | DB config with versioned migrations       |
| `apps/api/src/lib/chat/comment-index.ts`                     | CommentIndex class + open/get helpers     |
| `apps/api/src/routes/collab.ts`                               | Comment REST routes                       |
| `packages/lib/src/core/chat/hooks/use-comments.ts`           | Query hooks + keys + invalidation         |
| `packages/lib/src/types/chat.ts`                              | `CommentEntry` type                       |
| `packages/ui/src/components/layout/comments/comment-panel.tsx` | Comment side panel                       |
| `packages/ui/src/components/layout/comments/comment-thread.tsx` | Single comment thread                   |
| `packages/ui/src/components/layout/notes/note-card.tsx`       | Shared card component                     |
| `packages/ui/src/components/layout/notes/note-card-context-menu.tsx` | Shared context menu              |
| `packages/ui/src/components/layout/notes/note-card-dialog.tsx` | Shared dialog shell                      |
| `packages/ui/src/components/layout/comments/create-comment-dialog.tsx` | Shared comment creation dialog  |
| `apps/docs/src/components/docs/editor.tsx`                    | Docs editor integration                   |
| `apps/docs/src/components/docs/extensions/comment-mark.ts`   | ProseMirror plugins (interaction + decorations) |
| `apps/slides/src/components/slides/editor.tsx`                | Slides editor integration                 |
| `apps/slides/src/components/slides/hooks/use-active-comments.ts` | Scan objects for comment IDs          |
| `apps/sheets/src/components/sheets/editor.tsx`                | Sheets editor integration                 |
| `apps/sheets/src/components/sheets/hooks/use-active-comments.ts` | Scan cell matrix for comment IDs      |
| `packages/ui/src/styles/eigen-prose.css`                      | Comment highlight CSS                     |
