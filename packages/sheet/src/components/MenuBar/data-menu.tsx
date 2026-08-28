import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { size } from 'es-toolkit/compat';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { type Context, clearFilter, createFilter, en, sortSelection } from '../../state';
import { CustomSort } from '../CustomSort';
import { DataVerification } from '../DataVerification';
import { SplitColumn } from '../SplitColumn';

export function DataMenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const { sort, filter, toolbar } = en;

    const dispatch = (fn: (ctx: Context) => void) => () => setContext((draftCtx) => fn(draftCtx));

    const filterActive = size(context.filterRange) > 0;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{sort.sortTitle}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, true))}>
                        {sort.asc}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, false))}>
                        {sort.desc}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => showDialog(<CustomSort />)}>{sort.custom}</DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={dispatch((ctx) => (filterActive ? clearFilter(ctx) : createFilter(ctx)))}>
                {filterActive ? filter.clearFilter : filter.filter}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => showDialog(<DataVerification />)}>
                {toolbar.dataVerification}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => showDialog(<SplitColumn />)}>{toolbar.splitColumn}</DropdownMenuItem>
        </>
    );
}
