# Kanban Board (`dnd-board`)

This directory contains a minimal, collaborative Kanban board implementation for the Stickies app. The board supports
real-time multi-user editing and drag-and-drop, with state synchronized via a Yjs document and a websocket provider.

## Overview

- **UI**: Minimal, Trello-like Kanban board with columns and stickies (tasks).
- **Realtime Collaboration**: All board state is synchronized using Yjs and a websocket provider.
- **Drag & Drop**: Uses `@dnd-kit` for smooth drag-and-drop of columns and stickies.
- **State Management**: Yjs document serves as the single source of truth, with React state derived from it.

---

## Data Structures

All board data is modeled as follows (see `types.ts`):

- **TaskItem**: Represents a sticky (task) on the board.
    - `id`, `title`, `description`, `creator`, `createdAt`, `comments`
- **ColumnItem**: Represents a column (list) on the board.
    - `id`, `title`, `taskIds` (ordered array of task IDs), `creator`, `createdAt`
- **BoardData**: The full board state.
    - `tasks`: Record of all tasks by ID
    - `columns`: Record of all columns by ID
    - `columnOrder`: Ordered array of column IDs

---

## Architecture

The implementation follows a clean separation of concerns:

1. **Yjs Document (Model)**: The single source of truth for all data, enabling real-time collaboration.
2. **React State (View)**: Derived from the Yjs document, used only for rendering.
3. **Hooks (Controller)**: Manage interactions between the UI and the Yjs document.

This architecture ensures that:

- All changes go through the Yjs document first
- React state always reflects the Yjs document
- Multiple users can collaborate in real-time

---

## Drag & Drop Implementation

The drag and drop implementation uses a minimalist approach:

- **@dnd-kit/core** and **@dnd-kit/sortable** handle the core drag-and-drop mechanics.
- **Visual Feedback**: Ghost previews show where items will be placed during drag operations.
- **Two-Phase Commits**:
    1. During drag, only visual feedback is updated (no state mutation).
    2. On drag end, changes are committed to the Yjs document.

This approach prevents race conditions and ensures a smooth user experience, even with multiple users.

---

## Board Initialization

A dedicated `useInitializeBoard` hook handles board initialization:

- Creates default columns (To Do, In Progress, Done) when a new board is created.
- Adds a welcome sticky in the first column.
- Uses the current user's information for creator details.
- Initializes the board only if it's empty.

---

## State Synchronization Flow

1. **Local Mutations**: All UI actions (drag-and-drop, add sticky/column) mutate the Yjs document directly.
2. **Yjs → React**: Observers on the Yjs document update the React state when changes occur.
3. **Remote Changes**: The websocket provider receives changes from other users and applies them to the local Yjs
   document.
4. **React Rendering**: The UI updates to reflect the current state derived from the Yjs document.

This flow ensures that all clients stay in sync while maintaining a responsive local experience.

---

## Key Files

- `board.tsx` — Main Kanban board component with drag-and-drop setup.
- `column.tsx` — Column component that renders and manages stickies within it.
- `task-card.tsx` — Individual sticky card component with drag functionality.
- `hooks/useYjsKanbanBoard.ts` — Core hook for Yjs document setup and state mapping.
- `hooks/useYjsDragAndDrop.ts` — Hook for drag-and-drop logic and Yjs synchronization.
- `hooks/useInitializeBoard.ts` — Hook for initializing a new board with default content.
- `types.ts` — TypeScript interfaces for board data structures.

---

## Summary

This Kanban board implementation provides a clean, minimal, real-time collaborative experience. By using Yjs as the
single source of truth, it ensures data consistency across all clients while maintaining a smooth, responsive UI with
optimized drag-and-drop interactions.
