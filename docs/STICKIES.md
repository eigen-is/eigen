# Stickies (Kanban Board)

> **TLDR**: Collaborative Kanban board using Yjs for real-time sync + @dnd-kit for drag-drop. Board state lives in Yjs
> document as maps + arrays. All mutations go through Yjs first, React state derives from it. Stored as `.eigenstickies`
> Drive folders.

## Architecture

- **Yjs Document** (source of truth) → **React State** (derived, for rendering) → **Hooks** (controller)
- All changes go through Yjs first, then observers update React state
- Multiple users collaborate via WebSocket provider

## Data Model (`apps/stickies/src/components/stickies/dnd-board/types.ts`)

- **TaskItem**: `id`, `title`, `description`, `creator`, `createdAt`, `comments`
- **ColumnItem**: `id`, `title`, `taskIds` (ordered array), `creator`, `createdAt`
- **BoardData**: `tasks` (Record), `columns` (Record), `columnOrder` (array)

## Drag-and-Drop

Two-phase: visual feedback during drag (no state mutation), commit to Yjs on drag end.

## Key Files

All in `apps/stickies/src/components/stickies/dnd-board/`:

| File                          | Purpose                                    |
|-------------------------------|--------------------------------------------|
| `board.tsx`                   | Main board with drag-drop setup            |
| `column.tsx`                  | Column rendering                           |
| `task-card.tsx`               | Sticky card with drag                      |
| `hooks/useYjsKanbanBoard.ts`  | Yjs setup + state mapping                  |
| `hooks/useYjsDragAndDrop.ts`  | Drag-drop + Yjs sync                       |
| `hooks/useInitializeBoard.ts` | Default columns (To Do, In Progress, Done) |
| `types.ts`                    | TypeScript interfaces                      |
