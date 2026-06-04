import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getRangetxt } from '../../state';

export function NameBox() {
    const { context } = useContext(WorkbookContext);

    // biome-ignore lint/correctness/useExhaustiveDependencies: depending on the full context object would re-compute on every change; merge config is read but stable per sheet
    const rangeText = useMemo(() => {
        const lastSelection = context.selections?.[context.selections.length - 1];
        if (!(lastSelection && lastSelection.row_focus != null && lastSelection.column_focus != null)) return '';
        const rf = lastSelection.row_focus;
        const cf = lastSelection.column_focus;
        if (context.config.merge != null && `${rf}_${cf}` in context.config.merge) {
            return getRangetxt(context, context.currentSheetId, {
                column: [cf, cf],
                row: [rf, rf],
            });
        }
        return getRangetxt(context, context.currentSheetId, lastSelection);
    }, [context.currentSheetId, context.selections]);

    return (
        <div className="w-[99px] border-r border-border text-xs flex items-center">
            <div
                className="w-full text-center m-0 pl-2 pr-2 outline-none cursor-text whitespace-nowrap overflow-hidden bg-background break-words"
                tabIndex={0}
                dir="ltr"
            >
                {rangeText}
            </div>
        </div>
    );
}
