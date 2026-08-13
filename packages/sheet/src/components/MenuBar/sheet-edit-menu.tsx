import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useOptionalDocSearchBar } from '@workspace/ui/components/search/doc-search-provider';
import { type RefObject, useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import {
    clearSelectedContents,
    en,
    flushPendingCopy,
    handleCopy,
    handleCut,
    handleFormatPainter,
    handlePasteByClick,
    readClipboardText,
    tryDeleteRowCol,
} from '../../state';

// focusFindBarRef is owned by the parent DropdownMenuContent (MenuBar): a Find pick sets it so the
// menu's onCloseAutoFocus suppresses Radix's focus-restore to the trigger, which would otherwise
// steal focus back from the find bar.
export function SheetEditMenu({ focusFindBarRef }: { focusFindBarRef: RefObject<boolean> }) {
    const { context, setContext, refs, handleUndo, handleRedo } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const { toolbar, button } = en;
    const docSearchBar = useOptionalDocSearchBar();

    const selection = context.selections?.[0];
    const canUndo = refs.globalCache.undoList.length > 0;
    const canRedo = refs.globalCache.redoList.length > 0;

    return (
        <>
            {context.allowEdit && (
                <>
                    <DropdownMenuItem disabled={!canUndo} onClick={() => handleUndo()}>
                        {toolbar.undo}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!canRedo} onClick={() => handleRedo()}>
                        {toolbar.redo}
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />
                </>
            )}

            {context.allowEdit && (
                <DropdownMenuItem
                    onClick={() => {
                        setContext((draftCtx) => {
                            handleCut(draftCtx);
                            flushPendingCopy();
                        });
                    }}
                >
                    Cut
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        handleCopy(draftCtx);
                        flushPendingCopy();
                    });
                }}
            >
                Copy
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
            </DropdownMenuItem>
            <DropdownMenuItem
                disabled={!docSearchBar?.canReplace}
                onClick={() => {
                    focusFindBarRef.current = true;
                    docSearchBar?.openReplace();
                }}
            >
                Find and replace
            </DropdownMenuItem>
        </>
    );
}
