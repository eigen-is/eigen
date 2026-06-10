import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { CommentMenuItems } from '@workspace/ui/components/layout/comments';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import {
    ArrowDownAZ,
    ArrowDownZA,
    Clipboard,
    Copy,
    EyeOff,
    Filter,
    Image as ImageIcon,
    Link,
    type LucideIcon,
    MoveHorizontal,
    MoveVertical,
    Plus,
    Scissors,
    Trash2,
    X,
} from 'lucide-react';
import React, { useCallback, useContext } from 'react';
import { type SetContextOptions, WorkbookContext } from '../../context';
import { RowColError } from '../../engine';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    type Context,
    createFilter,
    deleteRowCol,
    deleteSelectedCellText,
    getFlowdata,
    getSheetIndex,
    handleCopy,
    handleCut,
    handleLink,
    handlePasteByClick,
    hideSelected,
    insertRowCol,
    isAllowEdit,
    jfrefreshgrid,
    removeActiveImage,
    type Settings,
    sortSelection,
} from '../../state';
import { ResizeDialog } from '../ResizeDialog';

// The app hardcodes the Mac modifier glyph elsewhere (command-palette shows ⌘K);
// platform-aware shortcut rendering is an app-wide concern, tracked separately.
const MOD = '⌘';

const MSG_MULTI = 'Cannot perform this operation on multiple selection areas, please select a single area';

type MenuCtx = {
    context: Context;
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void;
    settings: Required<Settings>;
    showAlert: ReturnType<typeof useAlert>['showAlert'];
    showDialog: ReturnType<typeof useDialog>['showDialog'];
    close: () => void;
};

type SheetMenuItem =
    | {
          kind: 'item';
          icon: LucideIcon;
          label: string;
          shortcut?: string;
          hidden?: (c: MenuCtx) => boolean;
          run: (c: MenuCtx) => void;
      }
    | { kind: 'separator' }
    | { kind: 'custom'; render: (c: MenuCtx) => React.ReactNode };

function insertRowColAction(c: MenuCtx, type: 'row' | 'column', direction: 'lefttop' | 'rightbottom') {
    const sel = c.context.selections?.[0];
    if (!sel) return;
    const axis = type === 'row' ? sel.row : sel.column;
    const op: SetContextOptions['insertRowColOp'] = {
        type,
        index: direction === 'lefttop' ? axis[0] : axis[1],
        count: 1,
        direction,
        id: c.context.currentSheetId,
    };
    c.setContext(
        (d) => {
            try {
                insertRowCol(d, op);
            } catch (err) {
                if (err instanceof RowColError && err.code === 'maxExceeded')
                    c.showAlert(type === 'row' ? '10000 row limit exceeded' : '1000 column limit exceeded', 'ok');
                else if (err instanceof RowColError && err.code === 'readOnly')
                    c.showAlert(
                        type === 'row' ? 'Cannot insert on read-only row' : 'Cannot insert into read-only column',
                        'ok',
                    );
            }
        },
        { insertRowColOp: op },
    );
}

function deleteRowColAction(c: MenuCtx, type: 'row' | 'column') {
    const sel = c.context.selections?.[0];
    if (!sel) return;
    const [start, end] = type === 'row' ? sel.row : sel.column;
    const op: SetContextOptions['deleteRowColOp'] = { type, start, end, id: c.context.currentSheetId };
    c.setContext(
        (d) => {
            if ((d.selections?.length ?? 0) > 1) {
                c.showAlert(MSG_MULTI, 'ok');
                return;
            }
            const index = getSheetIndex(d, c.context.currentSheetId);
            if (typeof index !== 'number') return;
            const data = d.sheets[index].data;
            const total = type === 'row' ? (data?.length ?? 0) : (data?.[0]?.length ?? 0);
            if (total <= end - start + 1) {
                c.showAlert(type === 'row' ? 'Cannot delete all rows' : 'Cannot delete all columns', 'ok');
                return;
            }
            try {
                deleteRowCol(d, op);
            } catch (e) {
                if (e instanceof RowColError && e.code === 'readOnly')
                    c.showAlert(type === 'row' ? 'Cannot delete row readonly' : 'Cannot delete column readonly', 'ok');
            }
        },
        { deleteRowColOp: op },
    );
}

const cut: SheetMenuItem = {
    kind: 'item',
    icon: Scissors,
    label: 'Cut',
    shortcut: `${MOD}X`,
    run: (c) => {
        c.setContext((d) => {
            handleCut(d);
        });
        c.close();
    },
};

const copy: SheetMenuItem = {
    kind: 'item',
    icon: Copy,
    label: 'Copy',
    shortcut: `${MOD}C`,
    run: (c) => {
        if ((c.context.selections?.length ?? 0) > 1) {
            c.showAlert(MSG_MULTI, 'ok');
            c.close();
            return;
        }
        c.setContext((d) => {
            handleCopy(d);
        });
        c.close();
    },
};

const paste: SheetMenuItem = {
    kind: 'item',
    icon: Clipboard,
    label: 'Paste',
    shortcut: `${MOD}V`,
    run: async (c) => {
        let clipboardText = '';
        try {
            clipboardText = await navigator.clipboard.readText();
        } catch {
            // Clipboard access can be blocked — fall back to our session copy.
        }
        const text = clipboardText || sessionStorage.getItem('localClipboard') || '';
        c.setContext((d) => {
            handlePasteByClick(d, text);
        });
        c.close();
    },
};

const insertItem = (type: 'row' | 'column', direction: 'lefttop' | 'rightbottom', label: string): SheetMenuItem => ({
    kind: 'item',
    icon: Plus,
    label,
    run: (c) => {
        insertRowColAction(c, type, direction);
        c.close();
    },
});

const deleteItem = (type: 'row' | 'column', label: string): SheetMenuItem => ({
    kind: 'item',
    icon: Trash2,
    label,
    run: (c) => {
        deleteRowColAction(c, type);
        c.close();
    },
});

const clearItem = (label: string): SheetMenuItem => ({
    kind: 'item',
    icon: X,
    label,
    run: (c) => {
        c.setContext((d) => {
            if (!isAllowEdit(d)) return;
            if (d.activeImg != null) {
                removeActiveImage(d);
            } else {
                const msg = deleteSelectedCellText(d);
                if (msg === 'partMC') c.showDialog('Cannot perform this operation on partially merged cells', 'ok');
                else if (msg === 'allowEdit') c.showDialog('Cannot perform this operation in read-only mode', 'ok');
                else if (msg === 'dataNullError')
                    c.showDialog('Cannot perform this operation on data that does not exist', 'ok');
            }
            jfrefreshgrid(d, null, undefined);
        });
        c.close();
    },
});

const hideItem = (type: 'row' | 'column', label: string): SheetMenuItem => ({
    kind: 'item',
    icon: EyeOff,
    label,
    run: (c) => {
        c.setContext((d) => {
            if (hideSelected(d, type) === 'noMulti') c.showDialog(MSG_MULTI);
        });
        c.close();
    },
});

const resizeItem = (mode: 'row' | 'column', label: string): SheetMenuItem => ({
    kind: 'item',
    icon: mode === 'row' ? MoveVertical : MoveHorizontal,
    label,
    run: (c) => {
        c.showDialog(<ResizeDialog mode={mode} />);
        c.close();
    },
});

const createFilterItem: SheetMenuItem = {
    kind: 'item',
    icon: Filter,
    label: 'Create a filter',
    run: (c) => {
        c.setContext((d) => {
            createFilter(d);
        });
        c.close();
    },
};

const sortItem = (asc: boolean, label: string): SheetMenuItem => ({
    kind: 'item',
    icon: asc ? ArrowDownAZ : ArrowDownZA,
    label,
    run: (c) => {
        c.setContext((d) => {
            sortSelection(d, asc);
        });
        c.close();
    },
});

const linkItem: SheetMenuItem = {
    kind: 'item',
    icon: Link,
    label: 'Insert link',
    run: (c) => {
        c.setContext((d) => {
            handleLink(d);
        });
        c.close();
    },
};

const imageItem: SheetMenuItem = {
    kind: 'item',
    icon: ImageIcon,
    label: 'Insert image',
    hidden: (c) => !c.settings.hooks.onInsertImage,
    run: (c) => {
        c.settings.hooks.onInsertImage?.();
        c.close();
    },
};

const commentItem: SheetMenuItem = {
    kind: 'custom',
    render: (c) => {
        const last = c.context.selections?.[c.context.selections.length - 1];
        const row = last ? (last.row_focus ?? last.row[0]) : 0;
        const col = last ? (last.column_focus ?? last.column[0]) : 0;
        const cell = getFlowdata(c.context)?.[row]?.[col];
        const hasComment = (cell?.commentCardIds?.length ?? 0) > 0;
        const info = hasComment ? (c.settings.hooks.getCommentInfo?.(row, col) ?? null) : null;
        const item = info ? { card: info.card, entry: info.entry } : null;
        if (!item && !c.settings.hooks.onAddComment) return null;

        const closeWith = <T extends unknown[]>(fn?: (...args: T) => void) =>
            fn
                ? (...args: T) => {
                      c.close();
                      fn(...args);
                  }
                : undefined;

        return (
            <CommentMenuItems
                primitives={{
                    Item: DropdownMenuItem,
                    Sub: DropdownMenuSub,
                    SubTrigger: DropdownMenuSubTrigger,
                    SubContent: DropdownMenuSubContent,
                }}
                item={item}
                onAddComment={closeWith(
                    c.settings.hooks.onAddComment ? () => c.settings.hooks.onAddComment!(row, col) : undefined,
                )}
                onOpen={closeWith(
                    c.settings.hooks.onViewComment ? () => c.settings.hooks.onViewComment!(row, col) : undefined,
                )}
                onChangeColor={closeWith(
                    c.settings.hooks.onCommentColor
                        ? (_cardId: string, color: string) => c.settings.hooks.onCommentColor!(row, col, color)
                        : undefined,
                )}
                onResolve={closeWith(c.settings.hooks.onCommentResolve)}
                onReopen={closeWith(c.settings.hooks.onCommentReopen)}
                onDelete={closeWith(
                    c.settings.hooks.onDeleteComment ? () => c.settings.hooks.onDeleteComment!(row, col) : undefined,
                )}
            />
        );
    },
};

const separator: SheetMenuItem = { kind: 'separator' };

const CELL_MENU: SheetMenuItem[] = [
    cut,
    copy,
    paste,
    separator,
    insertItem('row', 'lefttop', 'Insert 1 row above'),
    insertItem('column', 'lefttop', 'Insert 1 column to the left'),
    deleteItem('row', 'Delete row'),
    deleteItem('column', 'Delete column'),
    separator,
    clearItem('Clear contents'),
    createFilterItem,
    sortItem(true, 'Sort range A → Z'),
    sortItem(false, 'Sort range Z → A'),
    separator,
    linkItem,
    imageItem,
    commentItem,
];

const ROW_MENU: SheetMenuItem[] = [
    cut,
    copy,
    paste,
    separator,
    insertItem('row', 'lefttop', 'Insert 1 row above'),
    insertItem('row', 'rightbottom', 'Insert 1 row below'),
    deleteItem('row', 'Delete row'),
    clearItem('Clear row'),
    hideItem('row', 'Hide row'),
    resizeItem('row', 'Resize the row'),
    separator,
    createFilterItem,
];

const COLUMN_MENU: SheetMenuItem[] = [
    cut,
    copy,
    paste,
    separator,
    insertItem('column', 'lefttop', 'Insert 1 column to the left'),
    insertItem('column', 'rightbottom', 'Insert 1 column to the right'),
    deleteItem('column', 'Delete column'),
    clearItem('Clear column'),
    hideItem('column', 'Hide column'),
    resizeItem('column', 'Resize the column'),
    separator,
    createFilterItem,
    separator,
    sortItem(true, 'Sort sheet A → Z'),
    sortItem(false, 'Sort sheet Z → A'),
];

export type SheetMenuArea = 'cell' | 'row' | 'column';

const MENUS: Record<SheetMenuArea, SheetMenuItem[]> = { cell: CELL_MENU, row: ROW_MENU, column: COLUMN_MENU };

function renderSheetMenu(items: SheetMenuItem[], c: MenuCtx): React.ReactNode {
    return items.map((item, i) => {
        if (item.kind === 'separator') {
            // biome-ignore lint/suspicious/noArrayIndexKey: separators sit in a static config list
            return <DropdownMenuSeparator key={`sep-${i}`} />;
        }
        if (item.kind === 'custom') {
            // biome-ignore lint/suspicious/noArrayIndexKey: custom items sit in a static config list
            return <React.Fragment key={`custom-${i}`}>{item.render(c)}</React.Fragment>;
        }
        if (item.hidden?.(c)) return null;
        const Icon = item.icon;
        return (
            <DropdownMenuItem key={item.label} onClick={() => item.run(c)}>
                <Icon className="size-4" />
                {item.label}
                {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
        );
    });
}

// One menu instance per area, reused for every right-click in that region. The
// region's own onContextMenu still runs the selection logic; `open` then anchors
// this menu at the cursor (shared ContextMenuAnchor → DropdownMenu).
export function useSheetContextMenu(area: SheetMenuArea) {
    const { context, setContext, settings } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const { showDialog } = useDialog();
    const contextMenu = useContextMenu<boolean>();

    const c: MenuCtx = {
        context,
        setContext,
        settings,
        showAlert,
        showDialog,
        close: contextMenu.close,
    };

    const open = useCallback((e: React.MouseEvent) => contextMenu.handleContextMenu(e, true), [contextMenu]);

    return {
        open,
        // The menu content is portaled, but React bubbles its events along the component
        // tree — so a click inside the menu would otherwise reach the grid/header mousedown
        // handler and select the cell beneath it. Stop pointer events at the anchor.
        anchor: (
            <div
                className="contents"
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
            >
                <ContextMenuAnchor contextMenu={contextMenu}>{renderSheetMenu(MENUS[area], c)}</ContextMenuAnchor>
            </div>
        ),
    };
}
