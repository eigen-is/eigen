// The box left of the formula bar that names the selection, such as A1 or B2:C5. The formula bar renders it, lined up
// with the row header below it, and it updates with the selection. It only shows the name: it takes no focus, so the
// keys stay with the grid.

import { SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getRangetxt, getSheetConfig } from '../../state';

export function NameBox() {
    const { context } = useContext(WorkbookContext);

    // biome-ignore lint/correctness/useExhaustiveDependencies: depending on the full context object would re-compute on every change; the sheet's merge config is read but stable per sheet
    const rangeText = useMemo(() => {
        const lastSelection = context.selections?.[context.selections.length - 1];
        if (!(lastSelection && lastSelection.row_focus != null && lastSelection.column_focus != null)) return '';
        const rf = lastSelection.row_focus;
        const cf = lastSelection.column_focus;
        const merge = getSheetConfig(context)?.merge;
        if (merge != null && `${rf}_${cf}` in merge) {
            return getRangetxt(context, context.currentSheetId, {
                column: [cf, cf],
                row: [rf, rf],
            });
        }
        return getRangetxt(context, context.currentSheetId, lastSelection);
    }, [context.currentSheetId, context.selections]);

    return (
        // A press here would move the focus off the grid, which holds it for the keys.
        <div
            className="border-r border-border text-xs flex items-center"
            style={{ minWidth: SHEET_ROW_HEADER_WIDTH }}
            onMouseDown={(e) => e.preventDefault()}
        >
            <div className="w-full text-center px-2 whitespace-nowrap overflow-hidden" dir="ltr">
                {rangeText}
            </div>
        </div>
    );
}
