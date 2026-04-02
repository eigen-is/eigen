# Comments in Sheets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove fortune-sheet's built-in comment system and replace it with the shared Eigen comment infrastructure (CommentPanel, CommentThread, NoteCard, CreateCommentDialog), anchored to cells via `commentChatNames`.

**Architecture:** Two phases — (1) strip all comment/notation code from `packages/fortune-sheet/` and add `commentChatNames` to the Cell type, (2) integrate the shared comment system in `apps/sheets/` following the same pattern as slides. The canvas red triangle indicator is kept but re-pointed at the new field.

**Tech Stack:** React, fortune-sheet (forked), Yjs (op-based sync), TanStack Query, shared `@workspace/ui` + `@workspace/lib` comment packages.

**Spec:** `docs/superpowers/specs/2026-04-02-comments-in-sheets-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/fortune-sheet/src/core/types.ts` | Modify | Remove `ps` field from Cell, remove `CommentBox` type, remove `GlobalCache.commentBox`, add `commentChatNames` |
| `packages/fortune-sheet/src/core/context.ts` | Modify | Remove `commentBoxes`, `editingCommentBox`, `hoveredCommentBox` |
| `packages/fortune-sheet/src/core/modules/comment.ts` | Delete | Entire file |
| `packages/fortune-sheet/src/core/modules/index.ts` | Modify | Remove comment export |
| `packages/fortune-sheet/src/core/settings.ts` | Modify | Remove comment hooks, remove `"comment"` from default toolbar items |
| `packages/fortune-sheet/src/core/events/mouse.ts` | Modify | Remove all comment-related imports and calls |
| `packages/fortune-sheet/src/core/canvas.ts` | Modify | Change triangle trigger from `cell.ps` to `cell.commentChatNames?.length` |
| `packages/fortune-sheet/src/core/locale/en.ts` | Modify | Remove comment locale strings |
| `packages/fortune-sheet/src/core/modules/rowcol.ts` | Modify | Remove `delete templateCell.ps` |
| `packages/fortune-sheet/src/components/NotationBoxes/index.tsx` | Delete | Entire file |
| `packages/fortune-sheet/src/components/SheetOverlay/index.tsx` | Modify | Remove NotationBoxes import/render, remove comment box arrow drawing |
| `packages/fortune-sheet/src/components/Toolbar/index.tsx` | Modify | Remove comment toolbar dropdown |
| `packages/fortune-sheet/src/components/icon-map.tsx` | Modify | Remove comment icon mapping |
| `packages/fortune-sheet/src/core/test/comment/comment.test.ts` | Delete | Entire file |
| `packages/fortune-sheet/src/core/test/factories/cell.ts` | Modify | Remove `cellPs` and `editingCommentBox` factories |
| `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx` | Modify | Extract chatFolderId |
| `apps/sheets/src/components/sheets/editor.tsx` | Modify | Add MediaResolverProvider, comment state, panel, dialogs |
| `apps/sheets/src/components/sheets/toolbar.tsx` | Modify | Add comment toggle button |
| `apps/sheets/src/components/sheets/hooks/use-active-comments.ts` | Create | Scan cell matrix for commentChatNames |

---

### Task 1: Remove fortune-sheet comment module and types

**Files:**
- Delete: `packages/fortune-sheet/src/core/modules/comment.ts`
- Delete: `packages/fortune-sheet/src/core/test/comment/comment.test.ts`
- Modify: `packages/fortune-sheet/src/core/modules/index.ts`
- Modify: `packages/fortune-sheet/src/core/types.ts`
- Modify: `packages/fortune-sheet/src/core/context.ts`
- Modify: `packages/fortune-sheet/src/core/settings.ts`
- Modify: `packages/fortune-sheet/src/core/test/factories/cell.ts`

- [ ] **Step 1: Delete the comment module**

```bash
rm packages/fortune-sheet/src/core/modules/comment.ts
```

- [ ] **Step 2: Remove comment export from modules/index.ts**

In `packages/fortune-sheet/src/core/modules/index.ts`, remove line 18:

```ts
export * from "./comment";
```

- [ ] **Step 3: Remove ps field and CommentBox type from types.ts**

In `packages/fortune-sheet/src/core/types.ts`:

Remove the `ps` field from the `Cell` type (lines 50-57):
```ts
    ps?: {
        left: number | null;
        top: number | null;
        width: number | null;
        height: number | null;
        value: string;
        isShow: boolean;
    };
```

Add `commentChatNames` to the `Cell` type (after the `hl` field):
```ts
    commentChatNames?: string[];
```

Remove the `CommentBox` type (lines 161-173):
```ts
export type CommentBox = {
    r: number;
    c: number;
    rc: string;
    autoFocus: boolean;
    value: string;
    size: {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
    } & Rect;
} & Rect;
```

Remove `GlobalCache.commentBox` (lines 283-290):
```ts
    commentBox?: {
        movingId: string | undefined;
        resizingId: string | undefined;
        resizingSide: string | undefined;
        commentRC: { r: number; c: number; rc: string };
        boxInitialPosition: Rect | undefined;
        cursorMoveStartPosition: { x: number; y: number } | undefined;
    };
```

- [ ] **Step 4: Remove comment state from context.ts**

In `packages/fortune-sheet/src/core/context.ts`, remove lines 43-45:
```ts
    commentBoxes?: CommentBox[];
    editingCommentBox?: CommentBox;
    hoveredCommentBox?: CommentBox;
```

Also remove the `CommentBox` import if it's in the import list.

- [ ] **Step 5: Remove comment hooks and toolbar item from settings.ts**

In `packages/fortune-sheet/src/core/settings.ts`, remove lines 100-110 (the 6 comment hooks from the `Hooks` type):
```ts
    beforeUpdateComment?: (row: number, column: number, value: any) => boolean;
    afterUpdateComment?: (row: number, column: number, oldValue: any, value: any) => void;
    beforeInsertComment?: (row: number, column: number) => boolean;
    afterInsertComment?: (row: number, column: number) => void;
    beforeDeleteComment?: (row: number, column: number) => boolean;
    afterDeleteComment?: (row: number, column: number) => void;
```

Remove `"comment"` from the `defaultToolbarItems` array (line 216).

- [ ] **Step 6: Delete comment test file and clean up test factories**

```bash
rm packages/fortune-sheet/src/core/test/comment/comment.test.ts
rmdir packages/fortune-sheet/src/core/test/comment 2>/dev/null || true
```

In `packages/fortune-sheet/src/core/test/factories/cell.ts`, remove the `cellPs()` and `editingCommentBox()` factory functions and their imports.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(fortune-sheet): remove comment module, types, context state, and hooks"
```

---

### Task 2: Remove fortune-sheet comment UI components

**Files:**
- Delete: `packages/fortune-sheet/src/components/NotationBoxes/index.tsx`
- Modify: `packages/fortune-sheet/src/components/SheetOverlay/index.tsx`
- Modify: `packages/fortune-sheet/src/components/Toolbar/index.tsx`
- Modify: `packages/fortune-sheet/src/components/icon-map.tsx`

- [ ] **Step 1: Delete NotationBoxes component**

```bash
rm -r packages/fortune-sheet/src/components/NotationBoxes
```

- [ ] **Step 2: Remove NotationBoxes from SheetOverlay**

In `packages/fortune-sheet/src/components/SheetOverlay/index.tsx`:

Remove the import (line 41):
```ts
import {NotationBoxes} from "../NotationBoxes";
```

Remove the `<NotationBoxes/>` render (line 824).

Remove the `useLayoutEffect` block that draws comment box arrows (lines 391-413 — the entire block referencing `context.commentBoxes`, `context.hoveredCommentBox`, `context.editingCommentBox`, `drawArrow`).

Remove the `drawArrow` import if present.

Remove the commented-out block (lines 380-389) referencing `editingCommentBox`.

- [ ] **Step 3: Remove comment toolbar dropdown**

In `packages/fortune-sheet/src/components/Toolbar/index.tsx`, remove the entire `if (name === "comment")` block (lines 591-636). Also remove any imports from the comment module (`newComment`, `editComment`, `deleteComment`, `showHideComment`, `showHideAllComments`).

- [ ] **Step 4: Remove comment icon mapping**

In `packages/fortune-sheet/src/components/icon-map.tsx`, remove line 126:
```ts
    comment: MessageSquare,
```

If `MessageSquare` is no longer used anywhere in the file, remove it from the lucide-react import.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(fortune-sheet): remove NotationBoxes, comment toolbar, and icon mapping"
```

---

### Task 3: Remove comment event handlers from mouse.ts

**Files:**
- Modify: `packages/fortune-sheet/src/core/events/mouse.ts`
- Modify: `packages/fortune-sheet/src/core/locale/en.ts`
- Modify: `packages/fortune-sheet/src/core/modules/rowcol.ts`

- [ ] **Step 1: Clean up mouse.ts imports**

In `packages/fortune-sheet/src/core/events/mouse.ts`, remove these imports (lines 14-15, 23, 27):
```ts
    onCommentBoxMove,
    onCommentBoxMoveEnd,
    onCommentBoxResize,
    onCommentBoxResizeEnd,
    overShowComment,
    removeEditingComment,
```

- [ ] **Step 2: Remove comment calls from mouse event handlers**

Remove or comment out all lines that call these functions:

- Line 213: `removeEditingComment(ctx, globalCache);` — remove the line
- Lines 3370-3371: `if (onCommentBoxResize(...)) return;` and `if (onCommentBoxMove(...)) return;` — remove both lines
- Line 3375: `overShowComment(ctx, e, scrollX, scrollY, container);` — remove the line
- Lines 3648-3649: `onCommentBoxMoveEnd(...)` and `onCommentBoxResizeEnd(...)` — remove both lines
- Lines 4348, 4792, 5207, 5268, 5335, 5390: all `removeEditingComment(ctx, globalCache);` calls — remove each line

After removal, check that surrounding code still makes sense (no empty if-blocks, no dangling returns).

- [ ] **Step 3: Remove comment locale strings**

In `packages/fortune-sheet/src/core/locale/en.ts`:

Remove the toolbar tooltip (line 10970):
```ts
        comment: "Comment",
```

Remove the comment section (lines 11566-11572):
```ts
    comment: {
        insert: "Insert",
        edit: "Edit",
        delete: "Delete",
        showOne: "Show/Hide",
        showAll: "Show/Hide All",
    },
```

- [ ] **Step 4: Remove ps cleanup from rowcol.ts**

In `packages/fortune-sheet/src/core/modules/rowcol.ts`, remove lines 732 and 964:
```ts
                delete templateCell.ps;
```

- [ ] **Step 5: Verify build**

```bash
cd packages/fortune-sheet && npx tsc --noEmit
```

Fix any remaining references to removed types/functions. There may be additional imports or usages in files not listed above — search for `ps`, `CommentBox`, `commentBox`, `editingCommentBox`, `hoveredCommentBox`, `commentBoxes`, `NotationBoxes`, `drawArrow` and clean up any remaining references.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(fortune-sheet): remove comment mouse handlers, locale strings, and ps cleanup"
```

---

### Task 4: Update canvas triangle indicator

**Files:**
- Modify: `packages/fortune-sheet/src/core/canvas.ts`

- [ ] **Step 1: Change triangle trigger (standard rendering)**

In `packages/fortune-sheet/src/core/canvas.ts`, lines 1348-1357, change:

```ts
        if (flowdata?.[r]?.[c]?.ps) {
```

to:

```ts
        if (flowdata?.[r]?.[c]?.commentChatNames?.length) {
```

- [ ] **Step 2: Change triangle trigger (overflow rendering)**

Lines 1531-1540, change:

```ts
        if (cell?.ps) {
```

to:

```ts
        if (cell?.commentChatNames?.length) {
```

- [ ] **Step 3: Verify build**

```bash
cd packages/fortune-sheet && npx tsc --noEmit
cd apps/sheets && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/fortune-sheet/src/core/canvas.ts
git commit -m "feat(fortune-sheet): change canvas comment indicator to use commentChatNames"
```

---

### Task 5: Route + chatFolderId plumbing

**Files:**
- Modify: `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`
- Modify: `apps/sheets/src/components/sheets/editor.tsx`

- [ ] **Step 1: Extract chatFolderId in route**

In `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`, after line 36 (`const canWrite = ...`), add:

```ts
const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;
```

Pass it to SheetEditor:

```tsx
<SheetEditor
    ownerId={ownerId}
    path={path}
    canWrite={canWrite}
    chatFolderId={chatFolderId}
    onAccessDialogOpen={handleAccessDialogOpen}
/>
```

- [ ] **Step 2: Update SheetEditor props**

In `apps/sheets/src/components/sheets/editor.tsx`, add `chatFolderId: string | null` to `SheetEditorProps`:

```ts
type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};
```

Destructure `chatFolderId` in the function signature. Wrap the component's return with `MediaResolverProvider`:

```tsx
import { MediaResolverProvider } from '@workspace/lib/drive';

// In the component, wrap the outer div:
return (
    <MediaResolverProvider
        ownerId={ownerId}
        mountId={path.mountId}
        mediaFolderId={null}
        chatFolderId={chatFolderId}
    >
        <div className="flex flex-col h-full w-full">
            ...existing content...
        </div>
    </MediaResolverProvider>
);
```

- [ ] **Step 3: Commit**

```bash
git add apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx \
       apps/sheets/src/components/sheets/editor.tsx
git commit -m "feat(sheets): plumb chatFolderId from route to editor"
```

---

### Task 6: useActiveComments hook

**Files:**
- Create: `apps/sheets/src/components/sheets/hooks/use-active-comments.ts`

- [ ] **Step 1: Create the hook**

```ts
import type { Cell } from '@workspace/fortune-sheet';
import { useMemo } from 'react';

type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

function columnToLetter(c: number): string {
    let result = '';
    let n = c;
    while (n >= 0) {
        result = String.fromCharCode((n % 26) + 65) + result;
        n = Math.floor(n / 26) - 1;
    }
    return result;
}

export function useActiveComments(flowdata: (Cell | null)[][] | undefined): ActiveComments {
    return useMemo(() => {
        if (!flowdata) return EMPTY;

        const ids = new Set<string>();
        const anchorTexts = new Map<string, string>();

        for (let r = 0; r < flowdata.length; r++) {
            const row = flowdata[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const cell = row[c];
                if (!cell?.commentChatNames?.length) continue;
                for (const chatName of cell.commentChatNames) {
                    ids.add(chatName);
                    if (!anchorTexts.has(chatName)) {
                        anchorTexts.set(chatName, `Cell ${columnToLetter(c)}${r + 1}`);
                    }
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [flowdata]);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/sheets/src/components/sheets/hooks/use-active-comments.ts
git commit -m "feat(sheets): add useActiveComments hook"
```

---

### Task 7: Toolbar comment button

**Files:**
- Modify: `apps/sheets/src/components/sheets/toolbar.tsx`

- [ ] **Step 1: Add comment button to ToolbarRightItems**

Add `MessageSquare` to imports and new props:

```ts
import { MessageSquare, UserRoundPlus } from 'lucide-react';
```

Add comment props to `ToolbarItemsProps`:

```ts
type ToolbarItemsProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
};
```

Update `ToolbarRightItems`:

```tsx
export function ToolbarRightItems({
    canWrite,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    unresolvedCommentCount,
}: ToolbarItemsProps) {
    return (
        <>
            {onToggleCommentPanel && (
                <div className="relative">
                    <TooltipButton
                        icon={MessageSquare}
                        tooltipText="Comments"
                        onClick={onToggleCommentPanel}
                        active={commentPanelOpen}
                    />
                    {(unresolvedCommentCount ?? 0) > 0 && (
                        <span className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center pointer-events-none px-1">
                            {unresolvedCommentCount}
                        </span>
                    )}
                </div>
            )}
            {canWrite ? (
                <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
            ) : (
                <DocumentModeButton canWrite={canWrite} />
            )}
        </>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/sheets/src/components/sheets/toolbar.tsx
git commit -m "feat(sheets): add comment toggle button to toolbar"
```

---

### Task 8: Editor — comment panel, dialog, thread viewing, and sidebar

This is the main integration task.

**Files:**
- Modify: `apps/sheets/src/components/sheets/editor.tsx`

- [ ] **Step 1: Add imports**

```ts
import { useAuth } from '@workspace/lib/auth';
import { useComments, useResolveComment, useUpdateCommentColor } from '@workspace/lib/chat';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { MediaResolverProvider } from '@workspace/lib/drive';
import {
    CommentPanel,
    CommentThread,
    CreateCommentDialog,
    NoteCardContextMenu,
    NoteCardDialog,
} from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { useActiveComments } from './hooks/use-active-comments';
import { getFlowdata } from '@workspace/fortune-sheet';
```

Also add `useCallback, useMemo, useState` to the existing React import.

- [ ] **Step 2: Add comment state and hooks**

Inside `SheetEditor`, after the existing state:

```ts
const auth = useAuth();
const [commentPanelOpen, setCommentPanelOpen] = useState(false);
const [commentDialogOpen, setCommentDialogOpen] = useState(false);
const [commentSelectedText, setCommentSelectedText] = useState('');
const [commentCellRef, setCommentCellRef] = useState<{ r: number; c: number } | null>(null);
const [viewCommentChatName, setViewCommentChatName] = useState<string | null>(null);

const flowdata = workbookRef.current ? getFlowdata(workbookRef.current.getContext()) : undefined;
const activeComments = useActiveComments(flowdata);
const { data: allComments = [] } = useComments(ownerId, path.mountId, path.id);
const resolveComment = useResolveComment(ownerId, path.mountId, path.id);
const updateColor = useUpdateCommentColor(ownerId, path.mountId, path.id);
const commentContextMenu = useContextMenu<CommentEntry>();

const unresolvedCount = useMemo(() => {
    return allComments.filter((c) => c.status === 'open' && activeComments.ids.has(c.chatName)).length;
}, [allComments, activeComments.ids]);

const viewCommentEntry = viewCommentChatName
    ? allComments.find((c) => c.chatName === viewCommentChatName)
    : null;
```

Note: `getFlowdata` may need to be checked for export availability from fortune-sheet. The workbook ref provides `getContext()` which returns the context. If `getFlowdata` is not directly usable this way, use the `onChange` callback to track current data instead.

- [ ] **Step 3: Add comment handlers**

```ts
const handleAddComment = useCallback(
    (r: number, c: number) => {
        setCommentCellRef({ r, c });
        const cellLabel = `Cell ${String.fromCharCode(65 + (c % 26))}${r + 1}`;
        setCommentSelectedText(cellLabel);
        setCommentDialogOpen(true);
    },
    [],
);

const handleCommentCreated = useCallback(
    (chatName: string) => {
        if (!commentCellRef || !workbookRef.current) return;
        // Set commentChatNames on the cell via fortune-sheet API
        const ctx = workbookRef.current.getContext();
        const fd = getFlowdata(ctx);
        if (!fd) return;
        const cell = fd[commentCellRef.r]?.[commentCellRef.c];
        const current = cell?.commentChatNames ?? [];
        workbookRef.current.setCellValue(
            commentCellRef.r,
            commentCellRef.c,
            { ...cell, commentChatNames: [...current, chatName] },
        );
        updateColor.mutate({ chatName, color: EIGEN_STICKIES_COLORS[0][1].value });
        setCommentCellRef(null);
    },
    [commentCellRef, updateColor, workbookRef],
);
```

Note: The `setCellValue` API on `WorkbookInstance` may need verification. If it doesn't accept a full cell object, use the internal `setContext` approach instead. Check the fortune-sheet API surface — `setCellValue(r, c, value)` typically sets `cell.v`, so a different approach may be needed to set `commentChatNames`. A `setCellFormat` or direct context mutation via `workbookRef.current.setContext()` may be required. The implementer should check the available APIs and adapt.

- [ ] **Step 4: Wire toolbar comment props**

Update the `rightItems` useMemo to pass comment props:

```tsx
const rightItems = useMemo(
    () => (
        <ToolbarRightItems
            path={path}
            canWrite={canWrite}
            onAccessDialogOpen={onAccessDialogOpen}
            onRestore={handleRestore}
            onToggleCommentPanel={() => setCommentPanelOpen((v) => !v)}
            commentPanelOpen={commentPanelOpen}
            unresolvedCommentCount={unresolvedCount}
        />
    ),
    [path, canWrite, onAccessDialogOpen, handleRestore, commentPanelOpen, unresolvedCount],
);
```

- [ ] **Step 5: Add sidebar and dialogs to the layout**

Replace the current return with a flex layout that includes a sidebar:

```tsx
return (
    <MediaResolverProvider
        ownerId={ownerId}
        mountId={path.mountId}
        mediaFolderId={null}
        chatFolderId={chatFolderId}
    >
        <div className="flex flex-col h-full w-full">
            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 overflow-hidden">
                    <Workbook
                        ref={workbookRef}
                        data={initialData}
                        onChange={onDataChange}
                        onOp={handleOp}
                        showToolbar={true}
                        showFormulaBar={true}
                        showSheetTabs={true}
                        allowEdit={canWrite}
                        toolbarItems={TOOLBAR_ITEMS}
                        toolbarLeftItems={leftItems}
                        toolbarRightItems={rightItems}
                        defaultRowHeight={25}
                        defaultFontSize={11}
                        column={26}
                        row={100}
                    />
                </div>
                {commentPanelOpen && (
                    <CommentPanel
                        ownerId={ownerId}
                        mountId={path.mountId}
                        containerId={path.id}
                        currentUserEmail={auth.user!.email}
                        activeCommentIds={activeComments.ids}
                        anchorTexts={activeComments.anchorTexts}
                        onClose={() => setCommentPanelOpen(false)}
                        onCommentClick={(chatName) => setViewCommentChatName(chatName)}
                        onCommentContextMenu={commentContextMenu.handleContextMenu}
                    />
                )}
            </div>
        </div>

        {chatFolderId && (
            <CreateCommentDialog
                open={commentDialogOpen}
                onOpenChange={setCommentDialogOpen}
                ownerId={ownerId}
                mountId={path.mountId}
                chatFolderId={chatFolderId}
                selectedText={commentSelectedText}
                onCommentCreated={handleCommentCreated}
            />
        )}

        {viewCommentChatName && viewCommentEntry && (
            <NoteCardDialog
                open
                onOpenChange={(open) => {
                    if (!open) setViewCommentChatName(null);
                }}
                title={activeComments.anchorTexts.get(viewCommentChatName) || viewCommentChatName}
                description={
                    viewCommentEntry.lastAuthorEmail
                        ? `Comment by ${viewCommentEntry.lastAuthorEmail.split('@')[0]}`
                        : undefined
                }
            >
                <CommentThread ownerId={ownerId} mountId={path.mountId} chatName={viewCommentChatName} />
            </NoteCardDialog>
        )}

        <ContextMenuAnchor contextMenu={commentContextMenu}>
            <NoteCardContextMenu
                currentColor={commentContextMenu.item?.color}
                status={commentContextMenu.item?.status}
                onEdit={() => {
                    if (commentContextMenu.item) setViewCommentChatName(commentContextMenu.item.chatName);
                    commentContextMenu.close();
                }}
                onChangeColor={(color) => {
                    if (commentContextMenu.item)
                        updateColor.mutate({ chatName: commentContextMenu.item.chatName, color: color || null });
                    commentContextMenu.close();
                }}
                onResolve={() => {
                    if (commentContextMenu.item)
                        resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'resolved' });
                    commentContextMenu.close();
                }}
                onReopen={() => {
                    if (commentContextMenu.item)
                        resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'open' });
                    commentContextMenu.close();
                }}
                onDelete={() => {
                    if (!commentContextMenu.item) {
                        commentContextMenu.close();
                        return;
                    }
                    // Remove comment from cell — find which cell has this chatName
                    // This requires scanning flowdata and updating the cell
                    const chatName = commentContextMenu.item.chatName;
                    if (workbookRef.current && flowdata) {
                        for (let r = 0; r < flowdata.length; r++) {
                            const row = flowdata[r];
                            if (!row) continue;
                            for (let c = 0; c < row.length; c++) {
                                const cell = row[c];
                                if (cell?.commentChatNames?.includes(chatName)) {
                                    workbookRef.current.setCellValue(r, c, {
                                        ...cell,
                                        commentChatNames: cell.commentChatNames.filter((n) => n !== chatName),
                                    });
                                }
                            }
                        }
                    }
                    commentContextMenu.close();
                }}
            />
        </ContextMenuAnchor>
    </MediaResolverProvider>
);
```

- [ ] **Step 6: Verify build**

```bash
cd apps/sheets && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/sheets/src/components/sheets/editor.tsx
git commit -m "feat(sheets): wire up comment panel, dialog, and thread viewing"
```

---

### Task 9: Fortune-sheet context menu — add comment items

**Files:**
- Modify: `packages/fortune-sheet/src/components/ContextMenu/index.tsx`
- Modify: `packages/fortune-sheet/src/core/settings.ts`

- [ ] **Step 1: Add "comment" to default cellContextMenu**

In `packages/fortune-sheet/src/core/settings.ts`, add `"comment"` to the `cellContextMenu` default array (after `"sort"`):

```ts
    cellContextMenu: [
        "copy",
        "paste",
        "|",
        "insert-row",
        "insert-column",
        "delete-row",
        "delete-column",
        "delete-cell",
        "hide-row",
        "hide-column",
        "set-row-height",
        "set-column-width",
        "|",
        "clear",
        "sort",
        "|",
        "comment",
    ],
```

- [ ] **Step 2: Add comment items to ContextMenu component**

In `packages/fortune-sheet/src/components/ContextMenu/index.tsx`, add a `comment` handler in the `getMenuElement` function. Add the necessary imports and add after the last existing menu item handler:

```tsx
if (name === "comment") {
    const last = context.luckysheet_select_save?.[context.luckysheet_select_save.length - 1];
    let row_index = last?.row_focus;
    let col_index = last?.column_focus;
    if (!last) {
        row_index = 0;
        col_index = 0;
    } else {
        if (row_index == null) [row_index] = last.row;
        if (col_index == null) [col_index] = last.column;
    }
    const fd = getFlowdata(context);
    const cell = fd?.[row_index]?.[col_index];
    const hasComment = (cell?.commentChatNames?.length ?? 0) > 0;

    if (!hasComment) {
        return (
            <Menu
                key={name}
                onClick={() => {
                    setContext((draftCtx) => { draftCtx.contextMenu = {}; });
                    settings.hooks?.onAddComment?.(row_index, col_index);
                }}
            >
                Add comment
            </Menu>
        );
    }
    return (
        <React.Fragment key={name}>
            <Menu
                onClick={() => {
                    setContext((draftCtx) => { draftCtx.contextMenu = {}; });
                    settings.hooks?.onViewComment?.(row_index, col_index);
                }}
            >
                View comment
            </Menu>
            <Menu
                onClick={() => {
                    setContext((draftCtx) => { draftCtx.contextMenu = {}; });
                    settings.hooks?.onDeleteComment?.(row_index, col_index);
                }}
                style={{ color: "var(--destructive)" }}
            >
                Delete comment
            </Menu>
        </React.Fragment>
    );
}
```

- [ ] **Step 3: Add new hooks to Settings type**

In `packages/fortune-sheet/src/core/settings.ts`, add to the `Hooks` type:

```ts
    onAddComment?: (row: number, column: number) => void;
    onViewComment?: (row: number, column: number) => void;
    onDeleteComment?: (row: number, column: number) => void;
```

- [ ] **Step 4: Wire hooks from sheets editor**

In `apps/sheets/src/components/sheets/editor.tsx`, pass hooks to the `Workbook` component:

```tsx
<Workbook
    // ...existing props...
    hooks={{
        onAddComment: handleAddComment,
        onViewComment: (r, c) => {
            const fd = getFlowdata(workbookRef.current!.getContext());
            const chatName = fd?.[r]?.[c]?.commentChatNames?.[0];
            if (chatName) setViewCommentChatName(chatName);
        },
        onDeleteComment: (r, c) => {
            const fd = getFlowdata(workbookRef.current!.getContext());
            const cell = fd?.[r]?.[c];
            const chatName = cell?.commentChatNames?.[0];
            if (chatName && cell) {
                workbookRef.current!.setCellValue(r, c, {
                    ...cell,
                    commentChatNames: cell.commentChatNames!.filter((n) => n !== chatName),
                });
            }
        },
    }}
/>
```

- [ ] **Step 5: Verify build**

```bash
cd apps/sheets && npx tsc --noEmit
cd packages/fortune-sheet && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/fortune-sheet/src/components/ContextMenu/index.tsx \
       packages/fortune-sheet/src/core/settings.ts \
       apps/sheets/src/components/sheets/editor.tsx
git commit -m "feat(sheets): add comment items to cell context menu via hooks"
```

---

### Task 10: Update docs and final verification

**Files:**
- Modify: `docs/SHEETS.md`
- Modify: `docs/COMMENTS.md`

- [ ] **Step 1: Update SHEETS.md**

Add `commentChatNames` to the cell fields documentation. Note the removal of the fortune-sheet comment system.

- [ ] **Step 2: Update COMMENTS.md**

Add a "Sheets Editor Integration" section following the same pattern as the Slides section:
- Anchoring: cells via `commentChatNames: string[]`
- Active comments: scans cell matrix, anchor text = "Cell A1"
- Indicator: canvas red triangle (fortune-sheet built-in, changed to trigger on `commentChatNames`)
- Context menu: "Add comment" / "View comment" / "Delete comment" via fortune-sheet hooks
- Panel: CommentPanel in right sidebar

- [ ] **Step 3: Full build verification**

```bash
cd /Users/reinder/Documents/GitHub/eigen
npx tsc --noEmit -p apps/sheets/tsconfig.json
npx tsc --noEmit -p packages/fortune-sheet/tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add docs/SHEETS.md docs/COMMENTS.md
git commit -m "docs: update SHEETS.md and COMMENTS.md for comment system"
```
