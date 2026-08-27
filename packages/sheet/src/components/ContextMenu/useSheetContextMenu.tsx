import { CommentLifecycleMenuItems } from '@workspace/ui/components/comments';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    ArrowDownAZ,
    ArrowDownZA,
    Clipboard,
    Copy,
    Eye,
    EyeOff,
    Filter,
    Image as ImageIcon,
    Link,
    MoveHorizontal,
    MoveVertical,
    Plus,
    Scissors,
    Trash2,
    X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useContext } from 'react';
import { type SetContextOptions, WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    clearSelectedContents,
    createFilter,
    flushPendingCopy,
    getFlowdata,
    handleContextMenu,
    handleCopy,
    handleCut,
    handleLink,
    handlePasteByClick,
    hideSelected,
    readClipboardText,
    showSelected,
    sortSelection,
    tryDeleteRowCol,
    tryInsertRowCol,
} from '../../state';
import { ResizeDialog } from '../ResizeDialog';

// The app hardcodes the Mac modifier glyph elsewhere (command-palette shows ⌘K);
// platform-aware shortcut rendering is an app-wide concern, tracked separately.
const MOD = '⌘';

const MSG_MULTI = 'Cannot perform this operation on multiple selection areas, please select a single area';

type RowColType = 'row' | 'column';

function CutItem() {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    handleCut(d);
                    flushPendingCopy();
                })
            }
        >
            <Scissors className="size-4" />
            Cut
            <DropdownMenuShortcut>{MOD}X</DropdownMenuShortcut>
        </DropdownMenuItem>
    );
}

function CopyItem() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    return (
        <DropdownMenuItem
            onClick={() => {
                if ((context.selections?.length ?? 0) > 1) {
                    showAlert(MSG_MULTI, 'ok');
                    return;
                }
                setContext((d) => {
                    handleCopy(d);
                    flushPendingCopy();
                });
            }}
        >
            <Copy className="size-4" />
            Copy
            <DropdownMenuShortcut>{MOD}C</DropdownMenuShortcut>
        </DropdownMenuItem>
    );
}

function PasteItem() {
    const { setContext } = useContext(WorkbookContext);
    return (
        <DropdownMenuItem
            onClick={async () => {
                const text = await readClipboardText();
                setContext((d) => {
                    handlePasteByClick(d, text);
                });
            }}
        >
            <Clipboard className="size-4" />
            Paste
            <DropdownMenuShortcut>{MOD}V</DropdownMenuShortcut>
        </DropdownMenuItem>
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
    const { context, setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const insert = () => {
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
        setContext(
            (d) => {
                const error = tryInsertRowCol(d, op);
                if (error) showAlert(error, 'ok');
            },
            { insertRowColOp: op },
        );
    };
    return (
        <DropdownMenuItem onClick={insert}>
            <Plus className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function DeleteItem({ type, label }: { type: RowColType; label: string }) {
    const { context, setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const remove = () => {
        const sel = context.selections?.[0];
        if (!sel) return;
        const [start, end] = type === 'row' ? sel.row : sel.column;
        const op: SetContextOptions['deleteRowColOp'] = { type, start, end, id: context.currentSheetId };
        setContext(
            (d) => {
                if ((d.selections?.length ?? 0) > 1) {
                    showAlert(MSG_MULTI, 'ok');
                    return;
                }
                const error = tryDeleteRowCol(d, op);
                if (error) showAlert(error, 'ok');
            },
            { deleteRowColOp: op },
        );
    };
    return (
        <DropdownMenuItem onClick={remove}>
            <Trash2 className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function ClearItem({ label }: { label: string }) {
    const { setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    const error = clearSelectedContents(d);
                    if (error) showAlert(error, 'ok');
                })
            }
        >
            <X className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function HideItem({ type, label }: { type: RowColType; label: string }) {
    const { setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    if (hideSelected(d, type) === 'noMulti') showAlert(MSG_MULTI, 'ok');
                })
            }
        >
            <EyeOff className="size-4" />
            {label}
        </DropdownMenuItem>
    );
}

function ShowHiddenItem({ type, label }: { type: RowColType; label: string }) {
    const { setContext } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    return (
        <DropdownMenuItem
            onClick={() =>
                setContext((d) => {
                    if (showSelected(d, type) === 'noMulti') showAlert(MSG_MULTI, 'ok');
                })
            }
        >
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
    const { settings } = useContext(WorkbookContext);
    const { onInsertImage } = settings.hooks;
    if (!onInsertImage) return null;
    return (
        <DropdownMenuItem onClick={() => onInsertImage()}>
            <ImageIcon className="size-4" />
            Insert image
        </DropdownMenuItem>
    );
}

function CommentItems() {
    const { context, settings } = useContext(WorkbookContext);
    const { getCommentInfo, onAddComment, onDeleteComment, commentLifecycle } = settings.hooks;
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
            primitives={{
                Item: DropdownMenuItem,
                Sub: DropdownMenuSub,
                SubTrigger: DropdownMenuSubTrigger,
                SubContent: DropdownMenuSubContent,
            }}
            item={info ? { card: info.card, entry: info.entry } : null}
            canWrite={settings.allowEdit}
            onAddComment={onAddComment && (() => onAddComment(row, col))}
            onDelete={onDeleteComment && (() => onDeleteComment(row, col))}
        />
    );
}

function CellMenu() {
    return (
        <>
            <CutItem />
            <CopyItem />
            <PasteItem />
            <DropdownMenuSeparator />
            <InsertItem type="row" direction="lefttop" label="Insert 1 row above" />
            <InsertItem type="column" direction="lefttop" label="Insert 1 column to the left" />
            <DeleteItem type="row" label="Delete row" />
            <DeleteItem type="column" label="Delete column" />
            <DropdownMenuSeparator />
            <ClearItem label="Clear contents" />
            <CreateFilterItem />
            <SortItem ascending label="Sort range A → Z" />
            <SortItem ascending={false} label="Sort range Z → A" />
            <DropdownMenuSeparator />
            <LinkItem />
            <ImageItem />
            <CommentItems />
        </>
    );
}

function RowMenu() {
    return (
        <>
            <CutItem />
            <CopyItem />
            <PasteItem />
            <DropdownMenuSeparator />
            <InsertItem type="row" direction="lefttop" label="Insert 1 row above" />
            <InsertItem type="row" direction="rightbottom" label="Insert 1 row below" />
            <DeleteItem type="row" label="Delete row" />
            <ClearItem label="Clear row" />
            <HideItem type="row" label="Hide row" />
            <ShowHiddenItem type="row" label="Show hidden rows" />
            <ResizeItem type="row" label="Resize the row" />
            <DropdownMenuSeparator />
            <CreateFilterItem />
        </>
    );
}

function ColumnMenu() {
    return (
        <>
            <CutItem />
            <CopyItem />
            <PasteItem />
            <DropdownMenuSeparator />
            <InsertItem type="column" direction="lefttop" label="Insert 1 column to the left" />
            <InsertItem type="column" direction="rightbottom" label="Insert 1 column to the right" />
            <DeleteItem type="column" label="Delete column" />
            <ClearItem label="Clear column" />
            <HideItem type="column" label="Hide column" />
            <ShowHiddenItem type="column" label="Show hidden columns" />
            <ResizeItem type="column" label="Resize the column" />
            <DropdownMenuSeparator />
            <CreateFilterItem />
            <DropdownMenuSeparator />
            <SortItem ascending label="Sort column A → Z" />
            <SortItem ascending={false} label="Sort column Z → A" />
        </>
    );
}

export type SheetMenuArea = 'cell' | 'row' | 'column';

// The state layer names right-click regions by surface, the menus by axis.
const STATE_AREA = { cell: 'cell', row: 'rowHeader', column: 'columnHeader' } as const;

// One menu instance per area, reused for every right-click in that region. The
// returned onContextMenu runs the selection logic and anchors the menu at the
// cursor (shared ContextMenuAnchor → DropdownMenu).
export function useSheetContextMenu(area: SheetMenuArea) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const contextMenu = useContextMenu<boolean>();
    const { allowEdit } = context;
    const openMenu = contextMenu.handleContextMenu;
    const openMenuAt = contextMenu.openAt;

    const onContextMenu = useCallback(
        (e: React.MouseEvent) => {
            if (!allowEdit) return;
            setContext((d) => {
                handleContextMenu(d, e.nativeEvent, refs.cellArea.current!, STATE_AREA[area]);
            });
            openMenu(e, true);
        },
        [allowEdit, setContext, refs.cellArea, area, openMenu],
    );

    // Long-press (touch) entry: same select-then-open flow, positioned at viewport coords. The state
    // layer works in page coords, so add the scroll offset back on.
    const openAtPoint = useCallback(
        (x: number, y: number) => {
            if (!allowEdit) return;
            setContext((d) => {
                handleContextMenu(
                    d,
                    { pageX: x + window.scrollX, pageY: y + window.scrollY },
                    refs.cellArea.current!,
                    STATE_AREA[area],
                );
            });
            openMenuAt(true, x, y);
        },
        [allowEdit, setContext, refs.cellArea, area, openMenuAt],
    );

    return {
        onContextMenu,
        openAtPoint,
        anchor: (
            <ContextMenuAnchor
                contextMenu={contextMenu}
                // Return focus to the sheet's cell input, not whatever was focused
                // before the menu opened — Ctrl-Z and the other grid shortcuts read
                // keydown from the Workbook container around it.
                onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    refs.cellInput.current?.focus();
                }}
            >
                {area === 'cell' && <CellMenu />}
                {area === 'row' && <RowMenu />}
                {area === 'column' && <ColumnMenu />}
            </ContextMenuAnchor>
        ),
    };
}
