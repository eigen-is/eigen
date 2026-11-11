// The menu bar's Data menu: sorting the selection, a filter, data validation and splitting text into columns. Each
// item runs its action on the workbook or opens its dialog.

import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ArrowDownAZ, Columns2, Funnel, FunnelX, ShieldCheck } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { Context } from '../../state';
import { clearFilter, createFilter, sortSelection } from '../../state';
import { CustomSort } from '../CustomSort';
import { DataValidation } from '../DataValidation';
import { SplitColumn } from '../SplitColumn';

export function DataMenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();

    const dispatch = (fn: (ctx: Context) => void) => () => setContext(fn);

    const filterActive = context.sheets.find(({ id }) => id === context.currentSheetId)?.filterRange != null;
    // A sort works on one selected range.
    const selection = context.selections?.length === 1 ? context.selections[0] : undefined;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!selection}>
                    <ArrowDownAZ className="h-4 w-4" /> Sort range
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, true))}>Ascending</DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, false))}>
                        Descending
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => selection && showDialog(<CustomSort selection={selection} />)}>
                        Custom sort
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={dispatch((ctx) => (filterActive ? clearFilter(ctx) : createFilter(ctx)))}>
                {filterActive ? (
                    <>
                        <FunnelX className="h-4 w-4" /> Clear filter
                    </>
                ) : (
                    <>
                        <Funnel className="h-4 w-4" /> Create filter
                    </>
                )}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => showDialog(<DataValidation />)}>
                <ShieldCheck className="h-4 w-4" /> Data validation
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => showDialog(<SplitColumn />)}>
                <Columns2 className="h-4 w-4" /> Split text
            </DropdownMenuItem>
        </>
    );
}
