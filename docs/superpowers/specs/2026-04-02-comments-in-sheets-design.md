# Comments in Sheets

Add comment support to the sheets editor by removing fortune-sheet's built-in comment system and replacing it with the shared Eigen comment infrastructure (CommentPanel, CommentThread, NoteCard, CreateCommentDialog, comments.db).

## Part 1: Fortune-sheet Cleanup

Remove the entire built-in comment/notation system from `packages/fortune-sheet/`. The goal is maximum code removal.

### Remove entirely

| What | File | Details |
|------|------|---------|
| `cell.ps` field | `src/core/types.ts` L50-57 | The `ps` type and field on `Cell` |
| `CommentBox` type | `src/core/types.ts` L161-173 | Floating box type |
| `GlobalCache.commentBox` | `src/core/types.ts` L283-290 | Transient drag/resize state |
| Context fields | `src/core/context.ts` L43-47 | `commentBoxes`, `editingCommentBox`, `hoveredCommentBox` |
| Comment module | `src/core/modules/comment.ts` | Entire file (738 lines) — CRUD, hover, drag, resize, arrow |
| Module export | `src/core/modules/index.ts` | Remove `comment` export |
| NotationBoxes component | `src/components/NotationBoxes/index.tsx` | Entire file (176 lines) — yellow floating boxes |
| NotationBoxes usage | `src/components/Sheet/index.tsx` | Remove `<NotationBoxes />` render |
| Comment hooks | `src/core/settings.ts` L100-110 | `before/afterInsertComment`, `before/afterUpdateComment`, `before/afterDeleteComment` |
| Toolbar dropdown | `src/components/Toolbar/index.tsx` L591-636 | Comment toolbar menu items |
| `"comment"` in default toolbar | `src/core/settings.ts` L217 | Remove from `defaultToolbarItems` |
| Locale strings | `src/core/locale/en.ts` L11566-11572 | `comment: { insert, edit, delete, showOne, showAll }` |
| Toolbar tooltip | `src/core/locale/en.ts` L10970 | `comment: "Comment"` |
| Mouse event handlers | `src/core/events/mouse.ts` | `overShowComment` calls, `onCommentBoxMove/Resize` calls, `removeEditingComment` calls |
| Comment icon | `src/components/icon-map.tsx` L126 | `comment: MessageSquare` mapping |
| `ps` cleanup in row/col ops | `src/core/modules/rowcol.ts` L732, L964 | `delete templateCell.ps` |
| Test file | `src/core/test/comment/comment.test.ts` | Entire file |
| Test factories | `src/core/test/factories/cell.ts` | `cellPs()` and `editingCommentBox()` factories |

### Keep but modify

**Canvas triangle indicator** in `src/core/canvas.ts` (L1348-1357, L1531-1540):
- Change trigger from `cell.ps` to `cell.commentChatNames?.length`
- Keep the `#FC6666` red color and 8px triangle size

## Part 2: Cell Data Model

Add `commentChatNames?: string[]` to the `Cell` type in `packages/fortune-sheet/src/core/types.ts`. This field flows through the existing Yjs op-based sync automatically since it's part of the cell data matrix.

One comment per cell enforced in UI (context menu shows "Add comment" only when no comment exists), but the array type allows future extension.

## Part 3: Sheets App Integration

Follows the same pattern as the slides comment implementation.

### Route: extract chatFolderId

`apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx` — extract `chatFolderId` from `docInfo.folderContents` (same as slides route). Pass to `SheetEditor`.

### Editor: comment state and wiring

`apps/sheets/src/components/sheets/editor.tsx`:

- Wrap with `MediaResolverProvider` (needs `chatFolderId`)
- Add comment state: `commentPanelOpen`, `commentDialogOpen`, `commentSelectedText`, `commentCellRef`, `viewCommentChatName`
- Add hooks: `useAuth`, `useComments`, `useResolveComment`, `useUpdateCommentColor`, `useActiveComments`
- Add handlers: `handleAddComment(r, c)`, `handleCommentCreated(chatName)`, comment delete
- Comment mutations use `'comment'` transaction origin to exclude from Yjs UndoManager

### Toolbar: comment toggle button

`apps/sheets/src/components/sheets/toolbar.tsx` — add `MessageSquare` button with unresolved count badge in the right section, before Share button. Same markup as slides toolbar.

### Right sidebar: CommentPanel

Sheets currently has no right sidebar. Add one using the same pattern as slides: the `CommentPanel` shows alongside the workbook when toggled. Uses the shared `PropertiesPanel` wrapper (inherits `w-64`).

### useActiveComments hook

New file: `apps/sheets/src/components/sheets/hooks/use-active-comments.ts`

Scans the current sheet's cell data matrix for cells with non-empty `commentChatNames`. Returns `{ ids: Set<string>, anchorTexts: Map<string, string> }` where anchor text is the cell reference (e.g., `"Cell A1"`, `"Cell B12"`).

### Cell interaction

- **Click red triangle**: opens the comment thread via `NoteCardDialog` + `CommentThread`
- **Right-click cell with no comment**: "Add comment" in context menu
- **Right-click cell with comment**: "View comment", "Comment color" (submenu), "Resolve/Reopen", "Delete comment" — same flat structure as slides
- **Comment panel card click**: navigates to the sheet/cell containing the comment (scroll into view, select cell)

### CreateCommentDialog

Reuse the shared `CreateCommentDialog` from `@workspace/ui`. The `selectedText` shows the cell reference (e.g., `"Cell A1"`) or the cell's display value if it has one.

### NoteCardDialog + CommentThread

Same as slides: `viewCommentChatName` state, render `NoteCardDialog` with `CommentThread` inside.

### NoteCardContextMenu (panel right-click)

Same as slides: `ContextMenuAnchor` with `NoteCardContextMenu` for color/resolve/delete from the panel.

## Part 4: Fortune-sheet Context Menu Integration

Fortune-sheet has a right-click context menu on cells. Add comment items to it:

- **No comment on cell**: separator + "Add comment" (`MessageSquarePlus` icon)
- **Has comment**: separator + "View comment" / "Comment color >" / "Resolve comment" / "Delete comment" — flat items, no nesting (same as slides)

## What is NOT in scope

- Multi-sheet comment navigation (comments panel shows current sheet only)
- Comment indicators in the sheet tab bar
- Colored triangle indicator (keep uniform red — comment color shows in panel/context menu)
- Mobile layout

## Backend

No changes. The `.eigensheets` container already has `comments.db` and `chat/` folder created by `CollabDocument.create()`.
