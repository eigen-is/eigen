# Kanban Board (`dnd-board`)

This directory contains a minimal, collaborative Kanban board implementation for the Stickies app. The board supports real-time multi-user editing and drag-and-drop, with state synchronized via a Yjs document and a websocket provider.

## Overview

- **UI**: Minimal, Trello-like Kanban board with columns and cards.
- **Realtime Collaboration**: All board state is synchronized using Yjs and a websocket provider.
- **Drag & Drop**: Uses `@dnd-kit` for smooth drag-and-drop of columns and cards.
- **State Management**: Board state is stored in a Yjs document, which is mapped to React state for rendering and interaction.

---

## Data Structures

All board data is modeled as follows (see `types.ts`):

- **TaskItem**: Represents a card (task) on the board.
  - `id`, `title`, `description`, `creator`, `createdAt`, `comments`
- **ColumnItem**: Represents a column (list) on the board.
  - `id`, `title`, `taskIds` (ordered array of task IDs), `creator`, `createdAt`
- **BoardData**: The full board state.
  - `tasks`: Record of all tasks by ID
  - `columns`: Record of all columns by ID
  - `columnOrder`: Ordered array of column IDs

Example (see `initial-data.ts`):

```ts
{
  tasks: { 'task-1': { ... }, ... },
  columns: { 'column-1': { ... }, ... },
  columnOrder: ['column-1', 'column-2']
}
```

---

## Drag & Drop Implementation

- Uses `@dnd-kit/core` and `@dnd-kit/sortable` for drag-and-drop.
- **Columns** and **cards** are both sortable and draggable.
- Drag state is managed in React (see `hooks/useYjsDragAndDrop.ts`):
  - When a drag starts, the dragged item's info is stored in local drag state.
  - During drag, the board's React state is updated for immediate visual feedback.
  - On drag end, the changes are committed to the Yjs document, so all clients see the update.

---

## Yjs Document Structure

- The board state is stored in a Yjs document (`Y.Doc`), with the following shared types:
  - `tasks`: `Y.Map` of task objects
  - `columns`: `Y.Map` of column objects
  - `columnOrder`: `Y.Array` of column IDs
- Each task and column is itself a `Y.Map`. Task IDs within columns are stored as a `Y.Array`.

---

## State Synchronization

- The Yjs document is connected to a websocket provider (`y-websocket`), so all changes are propagated in real time to all clients.
- The custom hook `useYjsKanbanBoard` manages:
  - Initializing the Yjs document and provider
  - Mapping Yjs data to React state (`BoardData`)
  - Listening for changes and updating the React state accordingly
  - Providing handlers for adding tasks/columns, which mutate the Yjs document

---

## Change Handling and Rendering

- **Local changes** (e.g. drag-and-drop, add card/column) are first applied to the Yjs document.
- **Yjs Observers** listen for changes to the shared types and update the React state, triggering a re-render.
- **Remote changes** (from other clients) are received via the websocket provider, updating the Yjs doc and thus the React state.

---

## Key Files

- `board.tsx` — Main Kanban board component; wires up drag-and-drop and dialogs.
- `column.tsx`, `task-card.tsx` — UI for columns and cards, with sortable integration.
- `hooks/useYjsKanbanBoard.ts` — Hook for Yjs document setup, state mapping, and board actions.
- `hooks/useYjsDragAndDrop.ts` — Hook for drag-and-drop logic, including syncing with Yjs.
- `types.ts` — TypeScript interfaces for board data.
- `initial-data.ts` — Example initial board state.

---

## Summary

This Kanban board is a minimal, real-time collaborative board. All state is stored in a Yjs document, synchronized via websocket. Drag-and-drop is implemented with `@dnd-kit`, and all changes (local or remote) are reflected in the UI via React state updates.

---
