import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { addSheet, autoSelectionFormula, getFlowdata, handleLink, handleSum, insertRowCol, locale } from '../../state';
import { FormulaSearch } from '../FormulaSearch';

export function InsertMenu() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    const { showDialog, hideDialog } = useDialog();
    const { toolbar, rightclick, formula } = locale(context);

    const selection = context.selections?.[0];
    const rowFocus = selection?.row_focus;
    const columnFocus = selection?.column_focus;

    const last = context.selections?.[context.selections.length - 1];
    const commentRow = last?.row_focus ?? last?.row[0] ?? 0;
    const commentCol = last?.column_focus ?? last?.column[0] ?? 0;

    const insertHandler = (type: 'row' | 'column', direction: 'lefttop' | 'rightbottom') => {
        const focus = type === 'row' ? rowFocus : columnFocus;
        if (focus == null) return;
        const insertRowColOp = {
            type,
            index: focus,
            count: 1,
            direction,
            id: context.currentSheetId,
        };
        setContext(
            (draftCtx) => {
                insertRowCol(draftCtx, insertRowColOp);
            },
            { insertRowColOp },
        );
    };

    const fd = getFlowdata(context);
    const commentCell = fd?.[commentRow]?.[commentCol];
    const hasComment = (commentCell?.commentChatNames?.length ?? 0) > 0;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{rightclick.row}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                    <DropdownMenuItem disabled={rowFocus == null} onClick={() => insertHandler('row', 'lefttop')}>
                        Insert 1 row above
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={rowFocus == null} onClick={() => insertHandler('row', 'rightbottom')}>
                        Insert 1 row below
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{rightclick.column}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                    <DropdownMenuItem disabled={columnFocus == null} onClick={() => insertHandler('column', 'lefttop')}>
                        Insert 1 column left
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={columnFocus == null}
                        onClick={() => insertHandler('column', 'rightbottom')}
                    >
                        Insert 1 column right
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem
                onClick={() => {
                    setContext(
                        (draftCtx) => {
                            addSheet(draftCtx, settings);
                        },
                        { addSheetOp: true },
                    );
                }}
            >
                Sheet
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                disabled={!settings.hooks?.onInsertImage}
                onClick={() => {
                    settings.hooks?.onInsertImage?.();
                }}
            >
                {toolbar.insertImage}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{toolbar.autoSum}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((ctx) => {
                                handleSum(ctx, refs.cellInput.current!, refs.fxInput.current, refs.globalCache!);
                            });
                        }}
                    >
                        {formula.sum} (SUM)
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((ctx) => {
                                autoSelectionFormula(
                                    ctx,
                                    refs.cellInput.current!,
                                    refs.fxInput.current,
                                    'AVERAGE',
                                    refs.globalCache,
                                );
                            });
                        }}
                    >
                        {formula.average}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((ctx) => {
                                autoSelectionFormula(
                                    ctx,
                                    refs.cellInput.current!,
                                    refs.fxInput.current,
                                    'COUNT',
                                    refs.globalCache,
                                );
                            });
                        }}
                    >
                        {formula.count}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((ctx) => {
                                autoSelectionFormula(
                                    ctx,
                                    refs.cellInput.current!,
                                    refs.fxInput.current,
                                    'MAX',
                                    refs.globalCache,
                                );
                            });
                        }}
                    >
                        {formula.max}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            setContext((ctx) => {
                                autoSelectionFormula(
                                    ctx,
                                    refs.cellInput.current!,
                                    refs.fxInput.current,
                                    'MIN',
                                    refs.globalCache,
                                );
                            });
                        }}
                    >
                        {formula.min}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => showDialog(<FormulaSearch onCancel={hideDialog} />)}>
                        {`${formula.find}...`}
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem
                onClick={() => {
                    setContext((draftCtx) => {
                        handleLink(draftCtx);
                    });
                }}
            >
                {toolbar.insertLink}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {hasComment ? (
                <DropdownMenuItem
                    disabled={!settings.hooks?.onViewComment}
                    onClick={() => {
                        settings.hooks?.onViewComment?.(commentRow, commentCol);
                    }}
                >
                    View comment
                </DropdownMenuItem>
            ) : (
                <DropdownMenuItem
                    disabled={!settings.hooks?.onAddComment}
                    onClick={() => {
                        settings.hooks?.onAddComment?.(commentRow, commentCol);
                    }}
                >
                    Comment
                </DropdownMenuItem>
            )}
        </>
    );
}
