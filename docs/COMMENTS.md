# Comments

> **TLDR**: Unified comment-card model across stickies / docs / slides / sheets. Each card is a
> `{ id, title, description, color?, chatName? }` record stored in a Y.Map on the container's Y.Doc. The
> server-side `comments.db` SQLite index holds derived metadata (status, lastAuthorEmail, messageCount,
> mentions, createdAt, createdBy). Shared `<CardFormDialog>` and `<CardDialog>` in `packages/ui` render
> create + view/edit flows; per-app anchors connect cards to host content.

## Architecture

```
Y.Doc (per container)         comments.db (per container)            UI
─────────────────────────     ─────────────────────────────────      ──────────────────────────────
comments / tasks Y.Map        chatName (PK), status, resolvedBy,     useCommentCards (Y.Map → state)
  → CommentCard {              resolvedAt, lastAuthorEmail,          useCreateCommentCard (atomic
       id, title, description, lastMessageSnippet, lastActivityAt,    chat-create + Y.Doc write +
       color?, chatName?,      messageCount, createdAt, createdBy,    caller-supplied anchor)
       creator?, createdAt?    mentions[]                            useUpdateCommentCard / useDelete-
     }                                                                CommentCard
```

Each container document (eigendoc, eigenstickies, eigenslides, eigensheets) stores `comments.db`
alongside `data.db`. Comment chats live as `.eigenchat` folders in the container's `chat/` directory.

```
my-doc.eigendoc/
├── data.db              (Yjs collaborative state — includes the comments Y.Map)
├── comments.db          (server-side metadata index)
├── media/
└── chat/
    ├── comment-1.eigenchat/
    └── comment-2.eigenchat/
```

## Card storage (Y.Doc)

The shared `CommentCard` type (`packages/lib/src/types/comments.ts`):

```ts
type CommentCard = {
    id: string;
    title: string;
    description: string;
    color?: string;
    chatName?: string;
    creator?: string;     // user email at creation time
    createdAt?: number;   // ms epoch at creation time
};
```

`creator` + `createdAt` live on the Y.Doc so they're collaborative + undoable + survive a Y.Doc
version revert. The server-side `comments.db` row carries the same metadata as `createdBy` /
`createdAt` (set by `seedCommentRow` at chat creation) — the two paths are independent stores of
the same fact.

Cards live in a Y.Map keyed by `id`. The map name is per-app:
- **Stickies**: `tasks` (unchanged for backwards compatibility)
- **Docs / Slides / Sheets**: `comments`

Color lives on the Y.Doc card — undoable via the Y.UndoManager, collaborative via y-websocket, no
REST round-trip on color change.

## Per-app anchoring

Each app anchors a card to host content differently:

| App      | Anchor                                                                  |
|----------|-------------------------------------------------------------------------|
| Stickies | Column membership: `columnsMap.<col>.taskIds` contains the cardId       |
| Docs     | TipTap mark `data-comment-id="<cardId>"` on a text range                |
| Slides   | `BaseObject.commentCardIds: string[]` on the slide object               |
| Sheets   | `Cell.commentCardIds?: string[]` on the cell                            |

A card with no anchor is "orphaned" — its Y.Map entry, `.eigenchat`, and `comments.db` row all
persist (enabling undo/redo + Y.Doc version revert), but it is hidden from the comment panel.

## Database schema

**`comments` table** (`apps/api/src/lib/chat/comment-schema.ts`, v2 since 2026-05-17):
`chatName` (PK), `status` (open|resolved), `resolvedBy`, `resolvedAt`, `lastAuthorEmail`,
`lastMessageSnippet`, `lastActivityAt`, `messageCount`, `createdAt`, `createdBy`, `color` (unused
by new code; kept for legacy data — a future v3 can drop it).

**`comment_mentions` table**: `chatName` + `email` (composite PK).

## Row seeding

A `comments.db` row is created **at chat creation** when the new chat lands inside a container's
`chat/` folder. `Drive.create` calls a private `seedCommentRow(...)` helper that resolves the
container via `findContainerPath`, opens the index via `tryOpenCommentIndex` (returns `null` if
the container has no index yet), and calls `ensureComment(chatName, { createdBy: user.email })`.

The `ensureComment` upsert uses `INSERT ... ON CONFLICT DO UPDATE SET createdBy = COALESCE(createdBy,
EXCLUDED.createdBy)` — a real value is never overwritten by null, making the call idempotent.
`postMessage` also seeds on every message so legacy chats (pre-this-column) self-heal on first
activity.

Standalone chats (e.g. team-chats at mount root) get no `comments.db` row — same behavior as before
the column was added.

## CommentIndex service

`CommentIndex` (`apps/api/src/lib/chat/comment-index.ts`) wraps `comments.db`:

| Method           | Description                                                                       |
|------------------|-----------------------------------------------------------------------------------|
| `ensureComment`  | Idempotent upsert; accepts `{ createdBy?, createdAt? }` seed via COALESCE         |
| `updateActivity` | Update last author/snippet/activity, optionally increment `messageCount`          |
| `addMention`     | Insert mention row (dedup via composite PK)                                       |
| `resolve`        | Set `status='resolved'`, record `resolvedBy`/`resolvedAt`                         |
| `reopen`         | Set `status='open'`, clear resolved fields                                        |
| `decrementCount` | `MAX(0, messageCount - 1)`                                                        |
| `list`           | All comments with inline `mentions[]` (2 queries, grouped in memory)              |

All updates go through `ChatRoom.updateCommentIndex(fn)`, which opens the index, runs the callback,
and emits `CHAT_COMMENT_INDEX_UPDATED` SSE.

## API routes (`apps/api/src/routes/collab.ts`)

```
GET    /collab/:ownerId/:mountId/:pathId/comments                    List comments (with mentions[])
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/status   Resolve or reopen
```

There is no longer a `PATCH .../color` route — color lives on the Y.Doc card and round-trips via
y-websocket.

## Frontend hooks

**Server-derived metadata** (`packages/lib/src/core/chat/hooks/use-comments.ts`):

| Hook / export        | Description                                                          |
|----------------------|----------------------------------------------------------------------|
| `commentKeys`        | Query key factory: `all`, `container`, `list`                        |
| `useComments`        | `GET .../comments` — returns `CommentEntry[]`                        |
| `useResolveComment`  | `PATCH .../comments/:chatName/status`                                |
| `invalidateComments` | Called by SSE handler to invalidate container keys                   |

**Y.Doc card state** (`packages/lib/src/core/comments/`):

| Hook / helper             | Description                                                                       |
|---------------------------|-----------------------------------------------------------------------------------|
| `useCommentCards(doc, mapName)` | `Record<cardId, CommentCard>` synced to the Y.Map (`comments` or `tasks`)   |
| `useCommentLifecycle`     | The whole bundle above in one hook (open-card state, server entries, resolve mutation, create/update, `?chat=` resolution). Used by all four editors; `mapName` selects the Y.Map (`'comments'` default, stickies passes `'tasks'`), and hosts that mount before Yjs sync pass `ready` (+ optional `onChatNotFound`) |
| `useCreateCommentCard`    | Returns `(input, anchorInTransact?) => Promise<void>`. Creates the `.eigenchat`, then writes the card + runs the caller's anchor inside one Y.Doc `transact` → single undo step. The anchor callback receives the new `CommentCard` synchronously inside the transaction |
| `useUpdateCommentCard`    | `(cardId, patch) => void` — applies a partial patch to the Y.Map card             |
| `useOpenCommentCard`      | `(cards, entries, openCardId)` → `{ card, entry }` — resolves the open dialog's `chatName` against the server-side entries |
| `useCardIdFromChatName`   | Resolves a `?chat=<chatName>` URL param to a cardId. Optional `{ ready, onChatNotFound }` lets hosts gate on Yjs sync + clean up the URL when the chat genuinely doesn't exist |
| `useUnresolvedCommentCount` | `(cards, entries) => number` — count of non-resolved active comments for badges/toolbar UI |
| `readCards`, `writeCardToDoc`, `applyCardPatch` | Pure Y.Doc helpers (React-free, unit-tested) |

`useCommentCards` reads the map synchronously on mount (a host mounting after sync must see its
cards on the first effect run, or `?chat=` deep links die against an empty map) and preserves card
object identity across refreshes so memoized card components skip re-rendering. Deleting a card is
host-specific (the anchor strip *is* the delete); there is no shared delete hook.

## Shared UI components

### NoteCard (`packages/ui/src/components/layout/notes/`)

Shared card component used across all apps for list-row rendering. Renders a colored card with
title, description, status icon, and reply count. Also provides `NoteCardDialog` (dialog shell
with chat-thread slot).

### CommentMenuItems (`packages/ui/src/components/layout/comments/comment-menu-items.tsx`)

The single source of truth for the "Add / View / Color / Resolve / Reopen / Delete" menu used
across all four apps. Renders items inside whichever menu family the host uses by accepting a
`primitives` slot (`{ Item, Sub, SubTrigger, SubContent }` — either Radix `DropdownMenu*` or
`ContextMenu*` works). The `noun` prop tunes labels (`"comment"` by default, stickies passes
`"sticky"`).

### CommentContextMenu (`packages/ui/src/components/layout/comments/comment-context-menu.tsx`)

Convenience wrapper that pairs `<CommentMenuItems>` with the project's singleton
`useContextMenu` + `ContextMenuAnchor` pattern; `noun` tunes the labels (stickies passes
`"sticky"` through `<CommentLifecycleDialogs>`). All four editors render it via
`<CommentLifecycleDialogs>`; only the per-object slides menu uses `<CommentMenuItems>` directly
because its hosting menu differs.

### CommentLifecycleDialogs (`packages/ui/src/components/layout/comments/comment-lifecycle-dialogs.tsx`)

Renders the `<CardDialog>` + `<CommentContextMenu>` pair driven by a `useCommentLifecycle` bundle.
The host owns the `useContextMenu` instance and supplies the per-app `onDelete` that strips the
host anchor. Optional `noun` and `onCardDialogClose` (stickies clears its `?chat=` URL param on
close).

### CommentPanel (`packages/ui/src/components/layout/comments/comment-panel.tsx`)

Properties-panel overlay showing all comments for a document. The caller passes `cards`, `entries`,
`activeCardIds`, and `anchorTexts` — the panel is pure projection.

- **Tabs**: All / For you (filtered by `entries[].mentions[]` containing current user's email)
- **Status filter**: Open (default) / Resolved / All (cards without an entry yet are shown as "open")

### CommentThread (`packages/ui/src/components/layout/comments/comment-thread.tsx`)

Single comment thread: resolves `chatName` to `chatId` via `useMediaResolver`, renders
`ChatMessageList` + `ChatMessageInput`. Embedded inside `<CardDialog>` when a card has a `chatName`.

### CardFormDialog (`packages/ui/src/components/layout/cards/card-form-dialog.tsx`)

Shared create/edit form dialog selected by a `mode` prop (merges the former AddCardDialog +
CardSettingsDialog). The host wires `mode="create"` to `useCreateCommentCard` — typically:

```ts
const handleSaveNew = async ({ title, description, color }) => {
    await createCard({ title, description, color }, (card) => {
        // anchor: TipTap mark / commentCardIds append / column taskIds push
    });
};
```

- **`mode="create"`** (default) emits concrete values (trimmed title + seeded color) so a new card
  never persists an empty title or a missing color.
- **`mode="edit"`** emits a minimal patch (changed fields only), so an unchanged save is a no-op
  Yjs update.

Description is edited via `<LightEditor>`, color via the shared `<ColorPicker>`
(`EIGEN_STICKIES_COLORS`). Card creation is lazy: clicking "Add comment" opens the dialog purely
client-side; the backend is only touched on Save.

### CardDialog (`packages/ui/src/components/layout/cards/card-dialog.tsx`)

Shared view/edit dialog. Wraps `<NoteCardDialog>` with `<CommentThread>` inside; opens
`<CardFormDialog mode="edit">` for inline edits via `onUpdate`. Optional `showResolveAction` + `onResolve`
for apps that surface resolve/re-open at the dialog level (docs, slides, sheets).

## Per-app integration

### Docs

- TipTap mark `CommentMark` carries attribute `cardId`.
- `useActiveComments(editor)` walks the doc and collects `Set<cardId>` + first-anchor texts.
- `comment-mark.ts` decoration plugin keys decoration colors by `cardId` from the `cards` map.
- On selection right-click → CardFormDialog opens with the selected text as `initialTitle`. On save,
  `useCreateCommentCard`'s `anchorInTransact` callback runs `editor.chain().setComment(card.id)`.

### Slides

- `BaseObject.commentCardIds: string[]` stored as plain JS array in the Y.Map.
- `useActiveComments(deck)` scans objects; anchor text is first 100 chars of text objects or
  `"Image"` for image objects.
- Indicator triangle on each anchored object pulls `card.color`; first-unresolved wins.
- On Add Comment: anchor callback calls `addCommentToObject(objId, card.id)`.

### Sheets

- `Cell.commentCardIds?: string[]` (one-or-more cardIds per cell).
- `useActiveComments(flowdata)` scans the cell matrix; anchor text is `"Cell A1"` etc.
- Sheet canvas draws an indicator triangle; color comes from `hooks.getCommentInfo(r, c)` which the
  host wires up.
- Add Comment fires `hooks.onAddComment(r, c)`; the host opens CardFormDialog with the cell ref as
  initial title and then `setCellFormat(r, c, 'commentCardIds', [...existing, card.id])`.

### Stickies

- `tasks` Y.Map kept (legacy name; cards there are full `CommentCard`s). The board consumes
  `useCommentLifecycle({ mapName: 'tasks', ready: isSynced, ... })` + `<CommentLifecycleDialogs
  noun="sticky">` like its siblings; `useBoard` only manages columns/order, the provider, and the
  UndoManager.
- Cards are anchored by column membership in `columnsMap.<col>.taskIds`.
- Delete is a board-level helper `deleteCardFromBoard(cardId)` that walks columns + removes the
  Y.Map entry in one `transact` (single undo step, no orphan column refs).

## Active vs orphaned comments

The Y.Doc is the source of truth for which cards are "active":
- Anchor present in host content (mark / commentCardIds / column membership) → active
- Anchor absent (user removed it) → orphan; Y.Map entry, `.eigenchat`, and `comments.db` row all
  persist for undo/redo and version revert. CommentPanel hides orphans by intersecting
  `activeCardIds` with `cards`.

## Key files

| File                                                                | Purpose                                       |
|---------------------------------------------------------------------|-----------------------------------------------|
| `apps/api/src/lib/chat/comment-schema.ts`                           | Drizzle schema (v2)                           |
| `apps/api/src/lib/chat/comment-db-config.ts`                        | DB config + v1/v2 migrations                  |
| `apps/api/src/lib/chat/comment-index.ts`                            | CommentIndex + `openCommentIndex` + `tryOpenCommentIndex` |
| `apps/api/src/lib/drive/drive.ts`                                   | `seedCommentRow` helper called from `Drive.create` |
| `apps/api/src/routes/collab.ts`                                     | Comment REST routes (list + status)           |
| `packages/lib/src/core/chat/hooks/use-comments.ts`                  | Server-side metadata hooks + invalidation     |
| `packages/lib/src/core/comments/`                                   | Y.Doc card hooks + helpers (+ unit tests)     |
| `packages/lib/src/types/comments.ts`                                | `CommentCard` type                            |
| `packages/lib/src/types/chat.ts`                                    | `CommentEntry` type (server projection)       |
| `packages/lib/src/docs/eigendoc/nodes/comment-mark.ts`              | TipTap mark schema (attr `cardId`)            |
| `packages/lib/src/slides/types.ts`                                  | `BaseObject.commentCardIds`                   |
| `packages/lib/src/sheets/types.ts`                                  | `Cell.commentCardIds`                         |
| `packages/ui/src/components/layout/cards/`                          | Shared CardFormDialog + CardDialog |
| `packages/ui/src/components/layout/comments/`                       | CommentPanel + CommentThread + CommentMenuItems + CommentContextMenu + useCreatedByMeta |
| `packages/ui/src/components/layout/notes/`                          | NoteCard + NoteCardDialog                     |
| `apps/docs/src/components/docs/editor.tsx`                          | Docs editor integration                       |
| `apps/docs/src/components/docs/extensions/comment-mark.ts`          | ProseMirror plugins (interaction + decorations) |
| `apps/slides/src/components/slides/editor.tsx`                      | Slides editor integration                     |
| `apps/slides/src/components/slides/hooks/use-active-comments.ts`    | Scan objects for cardIds                      |
| `apps/sheets/src/components/sheets/editor.tsx`                      | Sheets editor integration                     |
| `apps/sheets/src/components/sheets/hooks/use-active-comments.ts`    | Scan cell matrix for cardIds                  |
| `apps/stickies/src/components/stickies/board.tsx`                   | Stickies board adoption                       |
| `apps/stickies/src/components/stickies/hooks/use-board.ts`          | Stickies hook (+ `deleteCardFromBoard`)        |
