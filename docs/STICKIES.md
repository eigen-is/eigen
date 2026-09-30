# Stickies (Kanban Board)

> **TLDR**: Collaborative Kanban board using Yjs for real-time sync + @dnd-kit for drag-drop. Stored as
> `.eigenstickies` Drive folders. All mutations go through Yjs first, React state derives from it.
> Cards are the shared `CommentCard` — the board only owns columns and their order.
> Each card gets an embedded chat room (eigenchat) for comments.

## Architecture

- **Yjs Document** (source of truth) → **React State** (derived, for rendering) → **Hooks** (controller)
- All changes go through Yjs first, then observers update React state
- Multiple users collaborate via WebSocket provider

## Yjs Data Model

```
Y.Map            "tasks"        → cardId → Y.Map (shared CommentCard shape)
Y.Map            "columns"      → columnId → Y.Map { id, title, taskIds: Y.Array<string>, creator, createdAt }
Y.Array<string>  "columnOrder"  → ordered column IDs
```

The `tasks` entries are **not** a stickies-specific type. They are written with the shared
`writeCardToDoc(doc, 'tasks', card)` and read back through `useCommentLifecycle({ ..., mapName: 'tasks' })`,
so the board and the comment infrastructure agree on one card shape. The undo manager tracks all three
roots, so a card add/remove and its column reference undo as one step.

## A concurrent merge can leave a card in two columns, or none

Two peers moving the same card at once can leave it in two columns' `taskIds`, or in none. `normalizeBoard` runs the shared `normalizeParentChildRefs` (`packages/lib/src/core/collab/normalize-refs.ts`) on the first sync and inside every drag commit. A card in several columns keeps the last one; a card in none joins the first. **First and last come from `columnOrder`, never from Y.Map key order.** Key order is each peer's local integration order, so peers would disagree and could delete each other's survivor. A column missing from `columnOrder` ranks before every listed one, so it never receives a re-homed card: the board doesn't render it.

The repair is idempotent. Run alone it writes under `NORMALIZE_ORIGIN`, which no UndoManager tracks, so it syncs to peers but ⌘Z can't restore the corruption. Inside a drag it joins the drag's undo step.

## Roots are read through typed accessors

The board reads its roots and id lists through `getItemMapRoot`, `getIdArrayRoot` and `getIdArray` (`packages/lib/src/core/collab/yjs-utils.ts`) instead of casting. A root needs no runtime check: `doc.get` upgrades the `AbstractType` root that `Y.applyUpdate` leaves on the server and throws only on a real mismatch. A nested list is checked with `instanceof Y.Array`, which is sound because nested types always decode with their real constructors. The server reader (`apps/api/src/lib/document/stickies.ts`) uses the same accessors through the React-free `@workspace/lib/collab/yjs-utils` subpath.

## Data Types

Cards are `CommentCard` from `packages/lib/src/types/comments.ts` — `id`, `title`, `description`, `color?`,
`chatName?`, `creator?`, `createdAt?`, `attachments?`. There is no board-local card type.

`apps/stickies/src/components/stickies/types.ts` holds only what the board itself owns:

- **ColumnItem**: `id`, `title`, `taskIds` (ordered array), `creator`, `createdAt`
- **BoardData**: `columns` (Record), `columnOrder` (array)

A card is "in" the board when some column's `taskIds` references it — that set is also what the lifecycle
hook treats as the active cards. Cards link to an eigenchat room via `chatName`; the chat is created at
card creation, and the thread opens in the shared card dialog when the card is clicked.

## Shared Comment Infrastructure

Most of `board.tsx` is wiring the shared comment modules rather than board-specific code — see
[COMMENTS.md](COMMENTS.md) for the card model, hooks and components:

- **`useCommentLifecycle`** — cards, comment entries, members, create/open/assign/resolve, plus
  `CommentLifecycleDialogs` for the card dialog, edit form, resolve and delete flows
- **`PanelColumn`** — the shared comments/activity pane. Stickies uses it for the **activity** panel and
  only on desktop; the toolbar hides the toggle on mobile, where the panel has nowhere to render
- **Comment filters** — `useCommentFilter` + `matchesCommentFilter` drive column contents. The board
  defaults to `status: 'all'` (resolved cards stay visible); the toolbar adds `CommentFilterMenuItems`,
  a color-swatch row and a `FilterSummary` chip
- **Card context menu** — one `useContextMenu` instance, opened by right-click and by long-press on touch
  (cards are `touch-none`, so there is no native context menu)
- **In-board doc search** — `DocSearchProvider` + `useStickiesDocSearch` highlight matching cards and
  columns and scroll them into view; the palette's comment-search half reveals a card by `chatName`

## Drag-and-Drop

Two-phase: visual feedback during drag (no state mutation), commit to Yjs on drag end. Supports both card
reordering (within and across columns) and column reordering.

## Key Files

The board lives in `apps/stickies/src/components/stickies/` — `board.tsx` (composition, drag-drop, dialogs),
`column.tsx` + `sortable-note-card.tsx` (rendering), `hooks/use-board.ts` (Yjs setup, card/column creation),
`hooks/use-drag-and-drop.ts`, `normalize-board.ts`, `search-board.ts` and the column dialogs.

Everything card-shaped comes from the shared modules: `@workspace/lib/comments` (hooks, `writeCardToDoc`,
filters) and `@workspace/ui` (`NoteCard`, `CardFormDialog`, `CommentLifecycleDialogs`, `PanelColumn`).
