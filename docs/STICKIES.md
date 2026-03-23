# Stickies (Kanban Board)

> **TLDR**: Collaborative Kanban board using Yjs for real-time sync + @dnd-kit for drag-drop. Board state lives in Yjs
> document as maps + arrays. All mutations go through Yjs first, React state derives from it. Stored as `.eigenstickies`
> Drive folders.

## Architecture

- **Yjs Document** (source of truth) → **React State** (derived, for rendering) → **Hooks** (controller)
- All changes go through Yjs first, then observers update React state
- Multiple users collaborate via WebSocket provider

## Data Model (`apps/stickies/src/components/stickies/types.ts`)

- **TaskItem**: `id`, `title`, `description`, `creator`, `createdAt`, `comments`
- **ColumnItem**: `id`, `title`, `taskIds` (ordered array), `creator`, `createdAt`
- **BoardData**: `tasks` (Record), `columns` (Record), `columnOrder` (array)

## Drag-and-Drop

Two-phase: visual feedback during drag (no state mutation), commit to Yjs on drag end.

## Key Files

All in `apps/stickies/src/components/stickies/`:

| File                         | Purpose                               |
|------------------------------|---------------------------------------|
| `board.tsx`                  | Main board with drag-drop + undo/redo |
| `column.tsx`                 | Column rendering                      |
| `card.tsx`                   | Sticky card with drag                 |
| `card-dialog.tsx`            | Card detail dialog                    |
| `card-settings-dialog.tsx`   | Card settings                         |
| `column-settings-dialog.tsx` | Column settings                       |
| `add-card-dialog.tsx`        | New card dialog                       |
| `add-column-dialog.tsx`      | New column dialog                     |
| `sidebar.tsx`                | Board sidebar                         |
| `toolbar.tsx`                | Board toolbar                         |
| `normalize-board.ts`         | Board data normalization              |
| `hooks/use-board.ts`         | Yjs setup + state mapping             |
| `hooks/use-drag-and-drop.ts` | Drag-drop + Yjs sync                  |
| `types.ts`                   | TypeScript interfaces                 |
