// The workbook's app bar: the host's items and the Edit, View, Insert, Format and Data menus on the left, the format
// icon row in the middle and the host's other items on the right. The shared CenteredToolbar lays it out, as it does
// the other editors' bars, and Edit is the shared EditMenu with the workbook's clipboard and delete rows. While a cell
// is open, every menu hands the focus back to the cell editor as it closes.

import { ClipboardMenuItems } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { AppBarMenu, CenteredToolbar, EditMenu } from '@workspace/ui/components/layout/toolbar';
import { Menubar } from '@workspace/ui/components/menubar';
import { PaintRoller, Trash2 } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useCellEditorRefocus } from '../../hooks/useCellEditorRefocus';
import { useDialog } from '../../hooks/useDialog';
import { useEditorSelectionStyle } from '../../hooks/useEditorSelectionStyle';
import {
    clearSelectedContents,
    copyActiveObject,
    flushPendingCopy,
    handleCopy,
    handleCut,
    handleFormatPainter,
    pasteFromClipboard,
    selectAll,
    tryDeleteRowCol,
} from '../../state';
import { DataMenu } from './data-menu';
import { FormatMenu } from './format-menu';
import { FormatToolbar } from './format-toolbar';
import { InsertMenu } from './insert-menu';
import { ViewMenu } from './view-menu';

type Props = {
    leftItems?: ReactNode;
    rightItems?: ReactNode;
    ref?: Ref<HTMLDivElement>;
};

// The bar is a size container, so the icon row folds by the bar's own width, also when a panel narrows it.
// Below 512px the menus get less padding, so they fit beside the share buttons.
export function WorkbookMenuBar({ leftItems, rightItems, ref }: Props) {
    const { context, getContext, setContext, refs, handleUndo, handleRedo, pasteClipboard } =
        useContext(WorkbookContext);
    const { showNotice } = useDialog();
    const refocusCellEditor = useCellEditorRefocus();
    // Read once for the toolbar and the Format menu, so a caret move reads the editor once.
    const caret = useEditorSelectionStyle();

    // A stack a peer's edit took away stays pressable: the press says why nothing happens.
    const { undoList, redoList, cutByPeer } = refs.globalCache;
    const canUndo = undoList.length > 0 || cutByPeer?.undo === true;
    const canRedo = redoList.length > 0 || cutByPeer?.redo === true;

    // A selected chart or image cuts and copies itself, through the clipboard event the Workbook listens to.
    const cutOrCopy = (cut: boolean) => {
        if (context.activeObject) return copyActiveObject(cut);
        setContext((draftCtx) => {
            if (cut) handleCut(draftCtx);
            else handleCopy(draftCtx);
            flushPendingCopy();
        });
    };

    // Deletes the row or the column of the selection's focused cell.
    const deleteFocused = (type: 'row' | 'column') => {
        const { selections, currentSheetId } = getContext();
        const index = type === 'row' ? selections?.[0]?.row_focus : selections?.[0]?.column_focus;
        if (index == null) return;
        const deleteRowColOp = { type, start: index, end: index, id: currentSheetId };
        setContext((draftCtx) => tryDeleteRowCol(draftCtx, deleteRowColOp), { deleteRowColOp });
    };

    return (
        <div ref={ref} className="@container flex items-center h-12 app-gutter-x border-b border-border bg-background">
            <CenteredToolbar
                left={
                    <Menubar className="@max-[512px]:**:data-[slot=menubar-trigger]:px-2">
                        {leftItems}
                        <EditMenu
                            canEdit={context.allowEdit}
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onUndo={handleUndo}
                            onRedo={handleRedo}
                            contentClassName="w-56 sheet-mousedown-cancel"
                            onCloseAutoFocus={refocusCellEditor}
                            selectionItems={
                                <>
                                    <ClipboardMenuItems
                                        onCut={context.allowEdit ? () => cutOrCopy(true) : undefined}
                                        onCopy={() => cutOrCopy(false)}
                                        onPaste={
                                            context.allowEdit
                                                ? () => pasteFromClipboard(pasteClipboard, showNotice)
                                                : undefined
                                        }
                                        onSelectAll={() => setContext(selectAll)}
                                        selectionEmpty={!context.activeObject && !context.selections?.length}
                                    />
                                    {context.allowEdit && (
                                        <>
                                            <DropdownMenuItem onClick={() => setContext(handleFormatPainter)}>
                                                <PaintRoller className="h-4 w-4" /> Paint format
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuSub>
                                                <DropdownMenuSubTrigger>
                                                    <Trash2 className="h-4 w-4" /> Delete
                                                </DropdownMenuSubTrigger>
                                                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                                                    <DropdownMenuItem onClick={() => setContext(clearSelectedContents)}>
                                                        Clear contents
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => deleteFocused('row')}>
                                                        Row
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => deleteFocused('column')}>
                                                        Column
                                                    </DropdownMenuItem>
                                                </DropdownMenuSubContent>
                                            </DropdownMenuSub>
                                        </>
                                    )}
                                </>
                            }
                        />

                        {/* View, Insert, Format and Data only change the workbook, so a viewer doesn't see them, as
                            with FormatToolbar. Edit stays, as Copy and Find check each row. A viewer still reads
                            comments through the Comments panel. */}
                        {context.allowEdit && (
                            <>
                                <AppBarMenu
                                    label="View"
                                    contentClassName="w-56 sheet-mousedown-cancel"
                                    onCloseAutoFocus={refocusCellEditor}
                                >
                                    <ViewMenu />
                                </AppBarMenu>

                                <AppBarMenu
                                    label="Insert"
                                    contentClassName="w-56 sheet-mousedown-cancel"
                                    onCloseAutoFocus={refocusCellEditor}
                                >
                                    <InsertMenu />
                                </AppBarMenu>

                                <AppBarMenu
                                    label="Format"
                                    contentClassName="w-64 sheet-mousedown-cancel"
                                    onCloseAutoFocus={refocusCellEditor}
                                >
                                    <FormatMenu caret={caret} />
                                </AppBarMenu>

                                <AppBarMenu
                                    label="Data"
                                    contentClassName="w-56 sheet-mousedown-cancel"
                                    onCloseAutoFocus={refocusCellEditor}
                                >
                                    <DataMenu />
                                </AppBarMenu>
                            </>
                        )}
                    </Menubar>
                }
                center={<FormatToolbar caret={caret} />}
                right={rightItems}
            />
        </div>
    );
}
