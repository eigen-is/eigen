// The grid's right-click menu, with items for a cell, a row header or a column header, such as the clipboard, inserting
// and deleting rows and columns, hiding, sorting and filters. useSheetContextMenu selects what was clicked and opens
// the menu for one area, on a right click or a long press on touch.

import { CommentLifecycleMenuItems, DeleteCommentDialog } from '@workspace/ui/components/comments';
import {
    ClipboardMenuItems,
    ContextMenuAnchor,
    MenuSections,
    useContextMenu,
} from '@workspace/ui/components/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import {
    ArrowDownAZ,
    ArrowDownZA,
    Eye,
    EyeOff,
    Filter,
    Image as ImageIcon,
    Link,
    MoveHorizontal,
    MoveVertical,
    Plus,
    SquareCheck,
    Trash2,
    X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useContext } from 'react';
import type { SetContextOptions } from '../../context';
import { WorkbookContext } from '../../context';
import { useCellEditorRefocus } from '../../hooks/useCellEditorRefocus';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import {
    clearSelectedContents,
    createFilter,
    flushPendingCopy,
    getFlowdata,
    handleContextMenu,
    handleCopy,
    handleCut,
    handleLink,
    hideSelectedRowCol,
    insertCheckbox,
    ONE_AREA_ONLY,
    pasteFromClipboard,
    showSelectedRowCol,
    sortSelection,
    tryDeleteRowCol,
    tryInsertRowCol,
} from '../../state';
import { ResizeDialog } from '../ResizeDialog';

type RowColType = 'row' | 'column';

// The shared Cut, Copy, Paste rows on the grid's own clipboard handlers.
function ClipboardItems() {
    const { context, setContext, pasteClipboard } = useContext(WorkbookContext);
    const { showNotice } = useDialog();
    return (
        <ClipboardMenuItems
            onCut={() =>
                setContext((d) => {
                    handleCut(d);
                    flushPendingCopy();
                })
            }
            onCopy={() => {
                if ((context.selections?.length ?? 0) > 1) {
                    showNotice(ONE_AREA_ONLY);
                    return;
                }
                setContext((d) => {
                    handleCopy(d);
                    flushPendingCopy();
                });
            }}
            onPaste={() => pasteFromClipboard(pasteClipboard, showNotice)}
        />
    );
}

function InsertItem({
    type,
    direction,
    label,
}: {
    type: RowColType;
    direction: 'lefttop' | 'rightbottom';
    label: string;
}) {
    const { getContext, setContext } = useContext(WorkbookContext);
    const insert = () => {
        const context = getContext();
        const sel = context.selections?.[0];
        if (!sel) return;
        const axis = type === 'row' ? sel.row : sel.column;
        const op: SetContextOptions['insertRowColOp'] = {
            type,
            index: direction === 'lefttop' ? axis[0] : axis[1],
            count: 1,
            direction,
            id: context.currentSheetId,
        };
        setContext((d) => tryInsertRowCol(d, op), { insertRowColOp: op });
    };
    return (
        <DropdownMenuItem onClick={insert}>
            <Plus className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function DeleteItem({ type, label }: { type: RowColType; label: string }) {
    const { getContext, setContext } = useContext(WorkbookContext);
    const remove = () => {
        const context = getContext();
        const sel = context.selections?.[0];
        if (!sel) return;
        const [start, end] = type === 'row' ? sel.row : sel.column;
        const op: SetContextOptions['deleteRowColOp'] = { type, start, end, id: context.currentSheetId };
        setContext(
            (d) => {
                if ((d.selections?.length ?? 0) > 1) d.warnDialog = ONE_AREA_ONLY;
                else tryDeleteRowCol(d, op);
            },
            { deleteRowColOp: op },
        );
    };
    return (
        <DropdownMenuItem variant="destructive" onClick={remove}>
            <Trash2 className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function ClearItem({ label }: { label: string }) {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem onClick={() => setContext(clearSelectedContents)}>
            <X className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function HideItem({ type, label }: { type: RowColType; label: string }) {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem onClick={() => setContext((d) => hideSelectedRowCol(d, type))}>
            <EyeOff className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function ShowHiddenItem({ type, label }: { type: RowColType; label: string }) {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem onClick={() => setContext((d) => showSelectedRowCol(d, type))}>
            <Eye className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function ResizeItem({ type, label }: { type: RowColType; label: string }) {
    const { showDialog } = useDialog();
    const Icon = type === 'row' ? MoveVertical : MoveHorizontal;
    return (
        <DropdownMenuItem onClick={() => showDialog(<ResizeDialog mode={type} />)}>
            <Icon className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function CreateFilterItem() {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    createFilter(d);
                })
            }
        >
            <Filter className="size-4" />
            Create a filter
        </DropdownMenuItem>
    );
}

function SortItem({ ascending, label }: { ascending: boolean; label: string }) {
    const { setContext } = useContext(WorkbookContext);
    const Icon = ascending ? ArrowDownAZ : ArrowDownZA;
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    sortSelection(d, ascending);
                })
            }
        >
            <Icon className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function LinkItem() {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    handleLink(d);
                })
            }
        >
            <Link className="size-4" />
            Insert link
        </DropdownMenuItem>
    );
}

function ImageItem() {
    const { refs } = useContext(WorkbookContext);
    const { onInsertImage } = refs.hooks.current;
    if (!onInsertImage) return null;
    return (
        <DropdownMenuItem onClick={() => onInsertImage()}>
            <ImageIcon className="size-4" />
            Insert image
        </DropdownMenuItem>
    );
}

// The same action as Insert › Tick box. Someone who wants to turn a column of TRUE and FALSE into tick boxes looks
// in the cell's menu first, not under a menu that reads as creating something.
function TickBoxItem() {
    const { context, setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem
            disabled={context.selections?.[0] == null}
            onClick={() =>
                setContext((d) => {
                    insertCheckbox(d);
                })
            }
        >
            <SquareCheck className="size-4" />
            Tick box
        </DropdownMenuItem>
    );
}

// A dialog of the sheet's slot, which outlives the menu and hands the focus back to the grid as it closes.
function DeleteCommentAsk({ onDelete }: { onDelete: () => void }) {
    return <DeleteCommentDialog {...useDialogProps()} onDelete={onDelete} />;
}

function CommentItems({ part }: { part: 'rows' | 'delete' }) {
    const { context, refs } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const { getCommentInfo, onAddComment, onDeleteComment, commentLifecycle } = refs.hooks.current;
    const last = context.selections?.[context.selections.length - 1];
    const row = last ? (last.row_focus ?? last.row[0]) : 0;
    const col = last ? (last.column_focus ?? last.column[0]) : 0;
    const cell = getFlowdata(context)?.[row]?.[col];
    const hasComment = (cell?.commentCardIds?.length ?? 0) > 0;
    const info = hasComment ? getCommentInfo?.(row, col) : null;

    if (!commentLifecycle) return null;

    return (
        <CommentLifecycleMenuItems
            lifecycle={commentLifecycle}
            item={info ? { card: info.card, entry: info.entry } : null}
            canWrite={context.allowEdit}
            onAddComment={onAddComment && (() => onAddComment(row, col))}
            onDelete={
                onDeleteComment &&
                ((cardId) => showDialog(<DeleteCommentAsk onDelete={() => onDeleteComment(cardId)} />))
            }
            part={part}
        />
    );
}

function CellMenu() {
    return (
        <MenuSections
            clipboard={<ClipboardItems />}
            create={
                <>
                    <InsertItem type="row" direction="lefttop" label="Insert 1 row above" />
                    <InsertItem type="column" direction="lefttop" label="Insert 1 column to the left" />
                    <DropdownMenuSeparator />
                    <LinkItem />
                    <ImageItem />
                    <TickBoxItem />
                </>
            }
            organize={
                <>
                    <ClearItem label="Clear contents" />
                    <CreateFilterItem />
                    <SortItem ascending label="Sort range A → Z" />
                    <SortItem ascending={false} label="Sort range Z → A" />
                </>
            }
            collaborate={<CommentItems part="rows" />}
            destructive={
                <>
                    <DeleteItem type="row" label="Delete row" />
                    <DeleteItem type="column" label="Delete column" />
                    <CommentItems part="delete" />
                </>
            }
        />
    );
}

function RowMenu() {
    return (
        <MenuSections
            clipboard={<ClipboardItems />}
            create={
                <>
                    <InsertItem type="row" direction="lefttop" label="Insert 1 row above" />
                    <InsertItem type="row" direction="rightbottom" label="Insert 1 row below" />
                </>
            }
            organize={
                <>
                    <ClearItem label="Clear row" />
                    <HideItem type="row" label="Hide row" />
                    <ShowHiddenItem type="row" label="Show hidden rows" />
                    <ResizeItem type="row" label="Resize the row" />
                    <DropdownMenuSeparator />
                    <CreateFilterItem />
                </>
            }
            destructive={<DeleteItem type="row" label="Delete row" />}
        />
    );
}

function ColumnMenu() {
    return (
        <MenuSections
            clipboard={<ClipboardItems />}
            create={
                <>
                    <InsertItem type="column" direction="lefttop" label="Insert 1 column to the left" />
                    <InsertItem type="column" direction="rightbottom" label="Insert 1 column to the right" />
                </>
            }
            organize={
                <>
                    <ClearItem label="Clear column" />
                    <HideItem type="column" label="Hide column" />
                    <ShowHiddenItem type="column" label="Show hidden columns" />
                    <ResizeItem type="column" label="Resize the column" />
                    <DropdownMenuSeparator />
                    <CreateFilterItem />
                    <SortItem ascending label="Sort column A → Z" />
                    <SortItem ascending={false} label="Sort column Z → A" />
                </>
            }
            destructive={<DeleteItem type="column" label="Delete column" />}
        />
    );
}

export type SheetMenuArea = 'cell' | 'row' | 'column';

// The state layer names the right-click areas by the surface clicked, and the menus by the axis.
const STATE_AREA = { cell: 'cell', row: 'rowHeader', column: 'columnHeader' } as const;

// One menu per area, reused for every right click in it. The onContextMenu it returns selects what was clicked and
// opens the shared ContextMenuAnchor at the pointer.
export function useSheetContextMenu(area: SheetMenuArea) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const contextMenu = useContextMenu<boolean>();
    const refocusCellEditor = useCellEditorRefocus();
    const { allowEdit } = context;
    const openMenu = contextMenu.handleContextMenu;
    const openMenuAt = contextMenu.openAt;

    const onContextMenu = useCallback(
        (e: React.MouseEvent) => {
            if (!allowEdit) return;
            setContext((d) => {
                const cellArea = refs.cellArea.current;
                if (cellArea) handleContextMenu(d, e.nativeEvent, cellArea, STATE_AREA[area]);
            });
            openMenu(e, true);
        },
        [allowEdit, setContext, refs.cellArea, area, openMenu],
    );

    // A long press on touch selects and opens the same way, at a point on screen.
    const openAtPoint = useCallback(
        (x: number, y: number) => {
            if (!allowEdit) return;
            setContext((d) => {
                const cellArea = refs.cellArea.current;
                if (cellArea) handleContextMenu(d, { clientX: x, clientY: y }, cellArea, STATE_AREA[area]);
            });
            openMenuAt(true, x, y);
        },
        [allowEdit, setContext, refs.cellArea, area, openMenuAt],
    );

    return {
        onContextMenu,
        openAtPoint,
        anchor: (
            <ContextMenuAnchor contextMenu={contextMenu} onCloseAutoFocus={refocusCellEditor}>
                {area === 'cell' && <CellMenu />}
                {area === 'row' && <RowMenu />}
                {area === 'column' && <ColumnMenu />}
            </ContextMenuAnchor>
        ),
    };
}
