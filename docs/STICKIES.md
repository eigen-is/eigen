# Stickies (Kanban Board)

> **TLDR**: Collaborative Kanban board using Yjs for real-time sync + @dnd-kit for drag-drop. Board state lives in Yjs
> document as maps + arrays. All mutations go through Yjs first, React state derives from it. Stored as `.eigenstickies`
> Drive folders. Each card gets an embedded chat room (eigenchat) for comments.

## Architecture

- **Yjs Document** (source of truth) → **React State** (derived, for rendering) → **Hooks** (controller)
- All changes go through Yjs first, then observers update React state
- Multiple users collaborate via WebSocket provider

## Yjs Data Model

```
Y.Map            "tasks"        → taskId → Y.Map { id, title, description, color, creator, createdAt, chatName }
Y.Map            "columns"      → columnId → Y.Map { id, title, taskIds: Y.Array<string>, creator, createdAt }
Y.Array<string>  "columnOrder"  → ordered column IDs
```

## Data Types (`apps/stickies/src/components/stickies/types.ts`)

- **CardItem**: `id`, `title`, `description`, `color?`, `creator`, `createdAt`, `chatName?`
- **ColumnItem**: `id`, `title`, `taskIds` (ordered array), `creator`, `createdAt`
- **BoardData**: `tasks` (Record), `columns` (Record), `columnOrder` (array)

Cards link to an eigenchat room via `chatName`. The chat is created when the card is created and displayed in the
`CardDialog` when the card is clicked.

## Drag-and-Drop

Two-phase: visual feedback during drag (no state mutation), commit to Yjs on drag end. Supports both card reordering
(within and across columns) and column reordering.

## Key Files

All in `apps/stickies/src/components/stickies/`:

| File                         | Purpose                                         |
|------------------------------|-------------------------------------------------|
| `board.tsx`                  | Main board with drag-drop, undo/redo + dialogs  |
| `column.tsx`                 | Column rendering                                |
| `card.tsx`                   | Sticky card with drag + card dialog trigger      |
| `card-dialog.tsx`            | Card detail dialog with embedded chat            |
| `card-settings-dialog.tsx`   | Card title/description/color editing             |
| `column-settings-dialog.tsx` | Column settings (rename, delete)                 |
| `add-card-dialog.tsx`        | New card dialog                                  |
| `add-column-dialog.tsx`      | New column dialog                                |
| `toolbar.tsx`                | Board toolbar (file menu, undo/redo, color filter) |
| `normalize-board.ts`         | Board data normalization (dedup tasks across columns) |
| `hooks/use-board.ts`         | Yjs setup + state mapping + card/column creation |
| `hooks/use-drag-and-drop.ts` | Drag-drop + Yjs sync                            |
| `types.ts`                   | TypeScript types                                 |
