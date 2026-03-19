# FE Code Review: Stickies

## Summary

The Stickies frontend is a Kanban board built with Yjs for real-time collaboration and @dnd-kit for drag-and-drop. The
architecture follows the documented pattern (Yjs document as source of truth, React state derived via observers). The
codebase is relatively compact (~750 lines of app-specific code) with clean separation between board logic, drag-drop,
and UI. Key concerns: read-only mode is not enforced on the board UI (only toolbar), the board initialization has a race
condition with an un-awaited async call, `canWrite` is not passed to card/column components so read-only users can
still mutate via card dialogs, hardcoded colors in drag overlay, and no error feedback (zero `toast` calls in the entire
app).

## Critical Issues

### 1. Read-only users can still mutate the board via UI

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/board.tsx`, lines 44, 148-157,
197-208

The `canWrite` prop is only used to:

- Disable undo/redo hotkeys (lines 68, 73, 78)
- Conditionally render toolbar buttons (toolbar.tsx lines 88, 98)

However, the board itself still renders:

- **"Add a sticky" buttons** on every column (`column.tsx` lines 56-60, 98-104) -- always visible
- **Card click handlers** that open `CardDialog` with edit functionality (`card.tsx` line 33)
- **Card settings dialog** with delete button (`card-settings-dialog.tsx`)
- **Column settings dialog** with delete button (`column-settings-dialog.tsx`)
- **Drag-and-drop** on all cards and columns -- read-only users can reorder

The backend WebSocket handler blocks write-type sync messages for read-only users (collab.ts line 280), so Yjs
mutations won't persist. But the user sees the change locally before it's silently reverted on the next sync -- a
confusing experience.

**Impact**: Poor UX for read-only users. Changes appear to work then disappear. Delete operations appear to succeed
locally then revert.

**Fix**: Pass `canWrite` down to `Column`, `StickyCard`, `CardDialog`, `CardSettingsDialog`, and
`ColumnSettingsDialog`. Disable drag listeners, hide add/edit/delete buttons, and show a read-only indicator when
`canWrite` is false.

### 2. Board initialization calls async function without awaiting in sync callback

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/hooks/use-board.ts`, lines
143-146

```typescript
wsProvider.on('sync', (isSynced: boolean) => {
    if (isSynced && columnsMap.size === 0) {
        initializeDefaultBoard(doc, user?.email || 'user@localhost');
    }
});
```

`initializeDefaultBoard` is `async` (it calls `createCardChat()` which does `mutateAsync`), but the return value is
not awaited. The `sync` callback is not async. This means:

- If `createCardChat` fails, the error is caught internally but the board initialization transaction has already
  completed without a chat name
- If two clients open an empty board simultaneously, both may enter this code path before the Yjs `columnsMap` reflects
  the other's initialization, resulting in duplicate default columns

**Impact**: Duplicate board initialization on concurrent first-open; fire-and-forget async in a sync callback violates
the project's "always await async calls" rule.

**Fix**: Make the sync handler properly handle the async operation. Consider using a debounce or lock to prevent
concurrent initialization.

### 3. `normalizeBoard` mutates Yjs document on every state read

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/normalize-board.ts`, lines 3-52

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/hooks/use-board.ts`, line 105

`normalizeBoard()` is called inside `updateReactState()` which fires on every Yjs `observeDeep` callback. This
function:

1. Scans all columns for duplicate task references
2. Removes duplicates (Yjs mutation)
3. Finds orphaned tasks and adds them to the first column (Yjs mutation)

These Yjs mutations trigger another `observeDeep` callback, causing `updateReactState` to fire again. This creates an
infinite loop that only terminates when `normalizeBoard` finds nothing to fix.

Additionally, `normalizeBoard` is also called inside `handleDragEnd` inside a `yjsDoc.transact()` (use-drag-and-drop.ts
line 108), which is correct. But calling it on every observer update means every remote update triggers normalization
mutations that propagate back to all clients.

**Impact**: Performance degradation with many cards/columns; unnecessary network traffic from normalization mutations
propagating to all clients; potential infinite observer loops if normalization itself creates inconsistencies.

**Fix**: Only call `normalizeBoard` inside explicit mutation transactions (like `handleDragEnd`), not on every observer
callback. If normalization is needed on sync, run it once after the initial sync completes, not on every update.

## Pattern Violations

### 4. `as any` used extensively with Yjs types

**Files**:

- `hooks/use-board.ts` lines 112, 124, 180
- `hooks/use-drag-and-drop.ts` lines 74, 75, 89, 90
- `card-settings-dialog.tsx` line 34
- `column-settings-dialog.tsx` lines 27, 42
- `normalize-board.ts` lines 14, 31, 43

Pattern: `as Y.Map<any>`, `as Y.Array<any>` -- 13 occurrences across 5 files.

The project rule states: "Never use `as any` -- fix the type at the source." While `Y.Map<any>` is slightly more
specific than plain `as any`, it still erases the inner type. Yjs `Map.get()` returns `any` when the type parameter
is `any`, so subsequent property access is unchecked.

**Fix**: Define typed Yjs helpers or wrapper functions:

```typescript
type YjsTaskMap = Y.Map<string | number | undefined>;
type YjsColumnMap = Y.Map<string | number | Y.Array<string>>;
```

Or create accessor functions that validate and type-narrow the returned values.

### 5. `interface` used instead of `type` in `__root.tsx`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/routes/__root.tsx`, line 14

```typescript
interface MyRouterContext {
    auth: AuthContextType
}
```

Project rule: "Always `type` over `interface` -- except when methods are needed." `MyRouterContext` has no methods.

### 6. Zero error feedback -- no `toast` calls anywhere

**Files**: All files in `apps/stickies/src/`

The project rule states: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`,
or use the `onError` callback."

The entire stickies app has zero `toast` imports or calls. The only error handling is:

- `createCardChat` in `use-board.ts` line 41: `console.error` (no user feedback)
- `add-card-dialog.tsx` line 30: `try/finally` with no `catch` (error silently propagated)

Operations that silently fail:

- Creating a card chat room
- Adding a card (if chat creation fails)
- Board initialization (if chat creation fails)

**Fix**: Add `toast.error()` calls for all user-facing operations that can fail, especially card/column
creation and deletion.

### 7. Hardcoded colors in card rendering

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/board.tsx`, line 130
**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/card.tsx`, line 50

```typescript
color: card.color ? (isLightColor(card.color) ? '#000' : '#fff') : undefined,
```

The `#000` and `#fff` are hardcoded text colors. While these are functional (used for contrast against card background
colors), the project rule says "Use theme tokens, not hardcoded colors." These particular values are intentional
overrides for colored cards, so this is a minor violation -- but they will not adapt to dark mode properly. A white
card with `#000` text in dark mode looks jarring.

**Note**: The `STICKY_COLORS` in `types.ts` (lines 30-51) are intentionally hardcoded as they represent specific
sticky-note colors, not theme colors. This is acceptable.

## Security Concerns

### 8. Card chat names derived from `Date.now()` are predictable

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/hooks/use-board.ts`, line 39

```typescript
const result = await createChatRef.current.mutateAsync({parentId: folderId, fileName: `task-${Date.now()}`});
```

Chat room file names use `task-{timestamp}`. These are predictable and could collide if two users create cards at the
same millisecond. The backend likely handles this, but using `nanoid` (already imported in this file) would be more
robust and consistent with how task/column IDs are generated.

## Data Integrity

### 9. `normalizeBoard` has edge case: orphaned tasks assigned to first column that may not exist

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/normalize-board.ts`, lines 40-51

```typescript
if (columnIds.length > 0) {
    const firstColumnValue = columnsMap.get(columnIds[0]);
...
}
```

`columnIds` is derived from `columnsMap.keys()`, but `columnIds[0]` may not match the first column in
`columnOrder`. Orphaned tasks are assigned to the first column by map iteration order, not by the user-visible column
order. This could confuse users when orphaned tasks appear in unexpected columns.

Additionally, if `firstColumn.get('taskIds')` returns `undefined` (corrupted column), the code will throw.

### 10. Column deletion deletes all cards in the column with no recovery

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/column-settings-dialog.tsx`,
lines 34-57

When a column is deleted, all its tasks are deleted from the `tasksMap`. While undo (via `UndoManager`) could
potentially recover this, the dialog closes immediately after deletion. If the user does not know about Ctrl+Z, the
data is permanently lost.

**Impact**: Accidental column deletion causes cascading task loss with no explicit recovery path in the UI.

**Fix**: Consider moving cards to another column instead of deleting them, or showing a confirmation that lists the
number of cards that will be deleted.

### 11. Drag-and-drop uses stale `board` state via closure

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/hooks/use-drag-and-drop.ts`,
lines 25-29, 68-106

The `findColumnOfTask` function and the `handleDragEnd` handler use `board` from the closure. During a drag operation,
if another user modifies the board (e.g., moves the same card), the local `board` state used in `handleDragEnd` may be
stale. This could result in:

- `findColumnOfTask` returning the wrong column
- `sourceArray.indexOf(activeId)` returning -1 (card already moved by another user)
- Inserting a card at the wrong position

The code does check `sourceIndex !== -1` (line 95) which prevents some errors, but the overall operation could still
produce unexpected results.

**Fix**: Read the current state from the Yjs document directly in `handleDragEnd` instead of relying on the React
state snapshot.

### 12. Board hidden when only 1 column exists

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/board.tsx`, lines 171-177

```typescript
style = {
    board.columnOrder.length > 1 ? {
        padding: 0,
        scrollSnapType: 'x mandatory',
        scrollBehavior: 'smooth',
    } : {
        visibility: 'hidden',
    }
}
```

When `columnOrder.length <= 1`, the entire board container is hidden. This means:

- A board with exactly 1 column is invisible
- An empty board (0 columns) is invisible
- The only way to add a column is via the toolbar "Add column" button, which requires `canWrite`

This appears intentional to hide the board during initialization (before default columns are created), but it also
hides the board if a user deletes all columns except one, or if someone creates a single-column board.

**Fix**: Change the condition to `board.columnOrder.length > 0` or `board.columnOrder.length >= 1`.

## Code Quality

### 13. `CardSettingsDialog` state not synced with props

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/card-settings-dialog.tsx`,
lines 23-25

```typescript
const [title, setTitle] = useState(cardTitle);
const [description, setDescription] = useState(cardDescription);
const [color, setColor] = useState(cardColor);
```

`useState` initial values are only used on first render. If the dialog is opened for different cards without
unmounting (e.g., by changing props while staying open), the state will show the previous card's data.

The same issue exists in `ColumnSettingsDialog` (line 18).

**Fix**: Use `useEffect` to reset state when `cardId`/`isOpen` changes, or use a key prop on the dialog to force
remount.

### 14. `DocsRoot` function name in `__root.tsx`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/routes/__root.tsx`, line 18

The root component is named `DocsRoot` -- appears to be copy-pasted from the docs app. Should be `StickiesRoot`.

### 15. `DriveContext` defined in `__root.tsx` instead of a dedicated file

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/routes/__root.tsx`, lines 9-12

The `DriveContext` is defined in the route file. This works but couples the context definition to the route module.
Other route files import from `'./__root'` (e.g., `_auth._sidebar.mime.$mimeType.tsx` line 8) which is unusual.

### 16. Unused `BoardProps` type

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/types.ts`, lines 25-28

```typescript
export type BoardProps = {
    ownerId: string;
    pathId: string;
}
```

This type is never imported or used anywhere in the codebase.

### 17. `jsonToYType` utility in board.tsx should be in a shared module

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/board.tsx`, lines 20-34

The `jsonToYType` function converts plain JSON to Yjs types. It's used only by the `handleRestore` callback. This is
a general-purpose Yjs utility that could be shared with the docs/slides/sheets apps if they also implement revision
restoration.

### 18. Inconsistent `nanoid` length

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/stickies/src/components/stickies/hooks/use-board.ts`

- Board initialization uses `nanoid(6)` for task/column IDs (lines 58, 70)
- `handleAddCard` uses `nanoid(10)` for task IDs (line 165)
- `handleAddColumn` uses `nanoid(10)` for column IDs (line 192)

The inconsistency between initialization IDs (6 chars) and runtime IDs (10 chars) is cosmetically inconsistent. Both
lengths are safe from collisions at typical board sizes, but standardizing on one length would be cleaner.

## Architecture

### 19. No shared stickies hooks in `packages/lib/src/core/stickies/`

Per the project pattern, domain-specific hooks should live in `packages/lib/src/core/[domain]/hooks/`. The stickies
app has no corresponding directory in `packages/lib`. All Yjs board logic lives directly in the app
(`apps/stickies/src/components/stickies/hooks/`).

The collab hooks (`useCollabDocumentInfo`, `useCollabRevisions`) are properly in `packages/lib/src/core/collab/hooks/`,
but the board-specific logic (Yjs data model, drag-drop, normalization) is app-local.

**Impact**: If other apps need to embed a Kanban board (e.g., in a docs sidebar), they can't reuse the board hooks.

**Recommendation**: This is acceptable for now since the board logic is tightly coupled to the Yjs data model and
UI. Consider extracting to `packages/lib` only if reuse is needed.

### 20. No SSE integration for stickies

The stickies app relies entirely on Yjs WebSocket sync for real-time updates. There are no SSE events for
stickies-specific actions (create/delete stickies files). The Drive SSE events presumably handle file-level changes
(create/rename/delete `.eigenstickies` files), but there's no stickies-specific SSE handler.

This is architecturally fine -- Yjs handles the collaborative editing, and Drive SSE handles the file listing. No
action needed.

## Positive Patterns

- **Clean Yjs integration**: The `useBoard` hook properly sets up Yjs document, WebSocket provider, observers, and
  cleanup. The observer pattern (Yjs -> React state) is correct.
- **UndoManager**: Properly configured to track all three Yjs shared types (columns, tasks, columnOrder).
- **Hotkeys**: Undo/redo keyboard shortcuts with proper modifier key handling (Mod+Z, Mod+Y, Mod+Shift+Z).
- **Two-phase drag**: Correct separation between visual feedback during drag and Yjs mutation on drag end.
- **MediaResolverProvider**: Properly wrapped for chat media resolution in card comments.
- **Revision history**: Integration with the shared `RevisionHistory` component and proper `handleRestore`
  implementation.
- **No direct `useQuery`/`useMutation` in app code**: All data hooks are properly in `packages/lib`.
- **Theme tokens used correctly**: `text-muted-foreground`, `bg-muted`, `bg-background`, `bg-accent` used throughout
  (except the card color override noted in #7).

## Recommendations

| Priority | Issue                                  | Action                                        |
|----------|----------------------------------------|-----------------------------------------------|
| P0       | #1 Read-only users can mutate board UI | Pass `canWrite` to all interactive components |
| P0       | #2 Un-awaited async in sync callback   | Properly handle async initialization          |
| P0       | #12 Board hidden with 1 column         | Fix visibility condition to `>= 1`            |
| P1       | #3 `normalizeBoard` on every observer  | Move to explicit mutation contexts only       |
| P1       | #6 Zero error feedback                 | Add `toast.error()` to all mutation paths     |
| P1       | #11 Stale board state in drag handler  | Read from Yjs doc directly                    |
| P1       | #13 Dialog state not synced with props | Add key prop or useEffect reset               |
| P2       | #4 `as Y.Map<any>` pattern             | Define typed Yjs accessors                    |
| P2       | #5 `interface` instead of `type`       | Change to `type MyRouterContext`              |
| P2       | #7 Hardcoded `#000`/`#fff`             | Consider theme-aware contrast                 |
| P2       | #8 Predictable chat names              | Use `nanoid` instead of `Date.now()`          |
| P2       | #10 Column delete cascades tasks       | Move tasks or show explicit count             |
| P2       | #14 `DocsRoot` naming                  | Rename to `StickiesRoot`                      |
| P2       | #16 Unused `BoardProps` type           | Remove dead code                              |
| P2       | #18 Inconsistent `nanoid` length       | Standardize on one length                     |
