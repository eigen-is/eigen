// The Insert menu of the sheet editor's menu bar, with items such as rows and columns beside the selection, a sheet, a
// chart from the selected range, an image or a comment through the host, and the Auto SUM functions.

import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    ChartColumn,
    CheckSquare,
    Columns3,
    ImagePlus,
    Link,
    MessageSquare,
    MessageSquarePlus,
    Rows3,
    Sheet,
    Sigma,
} from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { CHART_RANGE_REFUSALS } from '../../engine/chart-range';
import { useDialog } from '../../hooks/useDialog';
import {
    addSheet,
    autoSelectionFormula,
    getFlowdata,
    handleLink,
    insertChartFromSelection,
    insertCheckbox,
    tryInsertRowCol,
} from '../../state';
import { InsertFunctionDialog } from '../InsertFunctionDialog';

// The functions of the Auto SUM submenu, each with its menu label.
const AUTO_SUM_FUNCTIONS = [
    { formula: 'SUM', label: 'Sum (SUM)' },
    { formula: 'AVERAGE', label: 'Average' },
    { formula: 'COUNT', label: 'Count' },
    { formula: 'MAX', label: 'Max' },
    { formula: 'MIN', label: 'Min' },
] as const;

export function InsertMenu() {
    const { context, getContext, setContext, refs } = useContext(WorkbookContext);
    const hooks = refs.hooks.current;
    const { showDialog, showNotice } = useDialog();

    const selection = context.selections?.[0];
    const rowFocus = selection?.row_focus;
    const columnFocus = selection?.column_focus;

    const last = context.selections?.at(-1);
    const commentRow = last?.row_focus ?? last?.row[0] ?? 0;
    const commentCol = last?.column_focus ?? last?.column[0] ?? 0;

    const insertHandler = (type: 'row' | 'column', direction: 'lefttop' | 'rightbottom') => {
        const { selections, currentSheetId } = getContext();
        const focus = type === 'row' ? selections?.[0]?.row_focus : selections?.[0]?.column_focus;
        if (focus == null) return;
        const insertRowColOp = {
            type,
            index: focus,
            count: 1,
            direction,
            id: currentSheetId,
        };
        setContext((draftCtx) => tryInsertRowCol(draftCtx, insertRowColOp), { insertRowColOp });
    };

    const commentCell = getFlowdata(context)?.[commentRow]?.[commentCol];
    const hasComment = (commentCell?.commentCardIds?.length ?? 0) > 0;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <Rows3 className="h-4 w-4" /> Row
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem disabled={rowFocus == null} onClick={() => insertHandler('row', 'lefttop')}>
                        Insert 1 row above
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={rowFocus == null} onClick={() => insertHandler('row', 'rightbottom')}>
                        Insert 1 row below
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <Columns3 className="h-4 w-4" /> Column
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
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

            <DropdownMenuItem onClick={() => setContext((draftCtx) => addSheet(draftCtx), { addSheetOp: true })}>
                <Sheet className="h-4 w-4" /> Sheet
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                disabled={selection == null}
                onClick={() =>
                    setContext((draftCtx) => {
                        const refusal = insertChartFromSelection(draftCtx, crypto.randomUUID());
                        if (refusal) showNotice(CHART_RANGE_REFUSALS[refusal]);
                    })
                }
            >
                <ChartColumn className="h-4 w-4" /> Chart
            </DropdownMenuItem>

            <DropdownMenuItem disabled={!hooks.onInsertImage} onClick={() => hooks.onInsertImage?.()}>
                <ImagePlus className="h-4 w-4" /> Image
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <Sigma className="h-4 w-4" /> Auto SUM
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    {AUTO_SUM_FUNCTIONS.map(({ formula, label }) => (
                        <DropdownMenuItem
                            key={formula}
                            onClick={() => {
                                setContext((ctx) => {
                                    const cellInput = refs.cellInput.current;
                                    if (!cellInput) return;
                                    autoSelectionFormula(ctx, cellInput, refs.fxInput.current, formula);
                                });
                            }}
                        >
                            {label}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => showDialog(<InsertFunctionDialog />)}>
                        More functions…
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem onClick={() => setContext(handleLink)}>
                <Link className="h-4 w-4" /> Link
            </DropdownMenuItem>

            <DropdownMenuItem disabled={selection == null} onClick={() => setContext(insertCheckbox)}>
                <CheckSquare className="h-4 w-4" /> Tick box
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {hasComment ? (
                <DropdownMenuItem
                    disabled={!hooks.commentLifecycle}
                    onClick={() => {
                        const card = hooks.getCommentInfo?.(commentRow, commentCol)?.card;
                        if (card) hooks.commentLifecycle?.setOpenCardId(card.id);
                    }}
                >
                    <MessageSquare className="h-4 w-4" /> View comment
                </DropdownMenuItem>
            ) : (
                <DropdownMenuItem
                    disabled={!hooks.onAddComment}
                    onClick={() => hooks.onAddComment?.(commentRow, commentCol)}
                >
                    <MessageSquarePlus className="h-4 w-4" /> Comment
                </DropdownMenuItem>
            )}
        </>
    );
}
