import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    addSheet,
    autoSelectionFormula,
    en,
    getFlowdata,
    handleLink,
    handleSum,
    insertCheckbox,
    tryInsertRowCol,
} from '../../state';
import { InsertFunctionDialog } from '../InsertFunctionDialog';

export function InsertMenu() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    const { showAlert } = useAlert();
    const { showDialog, hideDialog } = useDialog();
    const { toolbar, formula } = en;

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
                const error = tryInsertRowCol(draftCtx, insertRowColOp);
                if (error) showAlert(error, 'ok');
            },
            { insertRowColOp },
        );
    };

    const fd = getFlowdata(context);
    const commentCell = fd?.[commentRow]?.[commentCol];
    const hasComment = (commentCell?.commentCardIds?.length ?? 0) > 0;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>Row</DropdownMenuSubTrigger>
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
                <DropdownMenuSubTrigger>Column</DropdownMenuSubTrigger>
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
                    <DropdownMenuItem onClick={() => showDialog(<InsertFunctionDialog onCancel={hideDialog} />)}>
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

            <DropdownMenuItem
                disabled={selection == null}
                onClick={() => {
                    setContext((draftCtx) => {
                        insertCheckbox(draftCtx);
                    });
                }}
            >
                {toolbar.tickBox}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {hasComment ? (
                <DropdownMenuItem
                    disabled={!settings.hooks?.commentLifecycle}
                    onClick={() => {
                        const card = settings.hooks?.getCommentInfo?.(commentRow, commentCol)?.card;
                        if (card) settings.hooks?.commentLifecycle?.setOpenCardId(card.id);
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
