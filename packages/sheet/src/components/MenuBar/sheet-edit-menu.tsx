// The menu bar's Edit menu, such as undo and redo, the clipboard, deleting rows and columns, and find. A row with
// a shortcut shows the same hotkey definition its key handler matches against, so the label names the key that works.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    FIND_HOTKEY,
    FIND_REPLACE_HOTKEY,
    useOptionalDocSearchBar,
} from '@workspace/ui/components/search/doc-search-provider';
import type { RefObject } from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import {
    clearSelectedContents,
    copyActiveObject,
    flushPendingCopy,
    handleCopy,
    handleCut,
    handleFormatPainter,
    handlePasteByClick,
    readClipboardText,
    SHEET_HOTKEYS,
    tryDeleteRowCol,
} from '../../state';

// The MenuBar owns focusFindBarRef and hands it in: a Find pick sets it, so the menu's onCloseAutoFocus
// skips Radix's focus-restore to the trigger, which would otherwise steal the focus back from the find bar.
export function SheetEditMenu({ focusFindBarRef }: { focusFindBarRef: RefObject<boolean> }) {
    const { context, setContext, refs, handleUndo, handleRedo } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const docSearchBar = useOptionalDocSearchBar();

    const selection = context.selections?.[0];
    const canUndo = refs.globalCache.undoList.length > 0;
    const canRedo = refs.globalCache.redoList.length > 0;

    return (
        <>
            {context.allowEdit && (
                <>
                    <DropdownMenuItem disabled={!canUndo} onClick={() => handleUndo()}>
                        Undo
                        <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.undo)}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canRedo} onClick={() => handleRedo()}>
                        Redo
                        <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.redo)}</DropdownMenuShortcut>
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />
                </>
            )}

            {context.allowEdit && (
                <DropdownMenuItem
                    onClick={() => {
                        if (context.activeObject) return copyActiveObject(true);
                        setContext((draftCtx) => {
                            handleCut(draftCtx);
                            flushPendingCopy();
                        });
                    }}
                >
                    Cut
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.cut)}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                onClick={() => {
                    if (context.activeObject) return copyActiveObject(false);
                    setContext((draftCtx) => {
                        handleCopy(draftCtx);
                        flushPendingCopy();
                    });
                }}
            >
                Copy
                <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.copy)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {context.allowEdit && (
                <>
                    <DropdownMenuItem
                        onClick={async () => {
                            const text = await readClipboardText();
                            setContext((draftCtx) => {
                                handlePasteByClick(draftCtx, text);
                            });
                        }}
                    >
                        Paste
                        <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.paste)}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((draftCtx) => {
                                handleFormatPainter(draftCtx);
                            });
                        }}
                    >
                        Paint format
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Delete</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            <DropdownMenuItem
                                onClick={() => {
                                    setContext((draftCtx) => {
                                        const error = clearSelectedContents(draftCtx);
                                        if (error) showAlert(error, 'ok');
                                    });
                                }}
                            >
                                Clear contents
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
                                            const error = tryDeleteRowCol(draftCtx, deleteRowColOp);
                                            if (error) showAlert(error, 'ok');
                                        },
                                        { deleteRowColOp },
                                    );
                                }}
                            >
                                Row
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
                                            const error = tryDeleteRowCol(draftCtx, deleteRowColOp);
                                            if (error) showAlert(error, 'ok');
                                        },
                                        { deleteRowColOp },
                                    );
                                }}
                            >
                                Column
                            </DropdownMenuItem>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </>
            )}

            <DropdownMenuSeparator />

            <DropdownMenuItem
                disabled={!docSearchBar}
                onClick={() => {
                    focusFindBarRef.current = true;
                    docSearchBar?.open();
                }}
            >
                Find
                <DropdownMenuShortcut>{formatForDisplay(FIND_HOTKEY)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
                disabled={!docSearchBar?.canReplace}
                onClick={() => {
                    focusFindBarRef.current = true;
                    docSearchBar?.openReplace();
                }}
            >
                Find and replace
                <DropdownMenuShortcut>{formatForDisplay(FIND_REPLACE_HOTKEY)}</DropdownMenuShortcut>
            </DropdownMenuItem>
        </>
    );
}
