import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { RowColError } from '../../engine';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    deleteRowCol,
    deleteSelectedCellText,
    getSheetIndex,
    handleCopy,
    handleCut,
    handleFormatPainter,
    handlePasteByClick,
    isAllowEdit,
    jfrefreshgrid,
    locale,
    removeActiveImage,
} from '../../state';

export function EditMenu() {
    const { context, setContext, refs, handleUndo, handleRedo } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const { showDialog } = useDialog();
    const { toolbar, rightclick, button, generalDialog } = locale(context);

    const selection = context.selections?.[0];
    const canUndo = refs.globalCache.undoList.length > 0;
    const canRedo = refs.globalCache.redoList.length > 0;

    return (
        <>
            <DropdownMenuItem disabled={!canUndo} onClick={() => handleUndo()}>
                {toolbar.undo}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canRedo} onClick={() => handleRedo()}>
                {toolbar.redo}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        handleCut(draftCtx);
                    });
                }}
            >
                Cut
            </DropdownMenuItem>
            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        handleCopy(draftCtx);
                    });
                }}
            >
                {rightclick.copy}
            </DropdownMenuItem>
            <DropdownMenuItem
                onClick={async () => {
                    let clipboardText = '';
                    const sessionClipboardText = sessionStorage.getItem('localClipboard') || '';
                    try {
                        clipboardText = await navigator.clipboard.readText();
                    } catch {
                        console.warn('Clipboard access blocked. Attempting to use sessionStorage fallback.');
                    }
                    const finalText = clipboardText || sessionClipboardText;
                    setContext((draftCtx) => {
                        handlePasteByClick(draftCtx, finalText);
                    });
                }}
            >
                {rightclick.paste}
            </DropdownMenuItem>
            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        handleFormatPainter(draftCtx);
                    });
                }}
            >
                {toolbar.paintFormat}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{button.delete}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((draftCtx) => {
                                const allowEdit = isAllowEdit(draftCtx);
                                if (!allowEdit) return;
                                if (draftCtx.activeImg != null) {
                                    removeActiveImage(draftCtx);
                                } else {
                                    const msg = deleteSelectedCellText(draftCtx);
                                    if (msg === 'partMC') {
                                        showDialog(generalDialog.partiallyError, 'ok');
                                    } else if (msg === 'allowEdit') {
                                        showDialog(generalDialog.readOnlyError, 'ok');
                                    } else if (msg === 'dataNullError') {
                                        showDialog(generalDialog.dataNullError, 'ok');
                                    }
                                }
                                jfrefreshgrid(draftCtx, null, undefined);
                            });
                        }}
                    >
                        {rightclick.clearContent}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            const row = selection?.row_focus;
                            if (row == null) return;
                            const deleteRowColOp = {
                                type: 'row' as const,
                                start: row,
                                end: row,
                                id: context.currentSheetId,
                            };
                            setContext(
                                (draftCtx) => {
                                    const index = getSheetIndex(draftCtx, context.currentSheetId) as number;
                                    if ((draftCtx.sheets[index].data?.length ?? 0) <= 1) {
                                        showAlert(rightclick.cannotDeleteAllRow, 'ok');
                                        return;
                                    }
                                    try {
                                        deleteRowCol(draftCtx, deleteRowColOp);
                                    } catch (e) {
                                        if (e instanceof RowColError && e.code === 'readOnly') {
                                            showAlert(rightclick.cannotDeleteRowReadOnly, 'ok');
                                        }
                                    }
                                },
                                { deleteRowColOp },
                            );
                        }}
                    >
                        {rightclick.row}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            const col = selection?.column_focus;
                            if (col == null) return;
                            const deleteRowColOp = {
                                type: 'column' as const,
                                start: col,
                                end: col,
                                id: context.currentSheetId,
                            };
                            setContext(
                                (draftCtx) => {
                                    const index = getSheetIndex(draftCtx, context.currentSheetId) as number;
                                    if ((draftCtx.sheets[index].data?.[0]?.length ?? 0) <= 1) {
                                        showAlert(rightclick.cannotDeleteAllColumn, 'ok');
                                        return;
                                    }
                                    try {
                                        deleteRowCol(draftCtx, deleteRowColOp);
                                    } catch (e) {
                                        if (e instanceof RowColError && e.code === 'readOnly') {
                                            showAlert(rightclick.cannotDeleteColumnReadOnly, 'ok');
                                        }
                                    }
                                },
                                { deleteRowColOp },
                            );
                        }}
                    >
                        {rightclick.column}
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        draftCtx.showSearch = true;
                    });
                }}
            >
                {toolbar.findAndReplace}
            </DropdownMenuItem>
        </>
    );
}
