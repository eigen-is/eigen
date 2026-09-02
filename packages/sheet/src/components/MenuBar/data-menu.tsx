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
import { type Context, clearFilter, createFilter, sortSelection } from '../../state';
import { CustomSort } from '../CustomSort';
import { DataVerification } from '../DataVerification';
import { SplitColumn } from '../SplitColumn';

export function DataMenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();

    const dispatch = (fn: (ctx: Context) => void) => () => setContext((draftCtx) => fn(draftCtx));

    const filterActive = size(context.filterRange) > 0;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>Sort range</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, true))}>Ascending</DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => sortSelection(ctx, false))}>
                        Descending
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => showDialog(<CustomSort />)}>Custom sort</DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={dispatch((ctx) => (filterActive ? clearFilter(ctx) : createFilter(ctx)))}>
                {filterActive ? 'Clear filter' : 'create filter'}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => showDialog(<DataVerification />)}>Data verification</DropdownMenuItem>
            <DropdownMenuItem onClick={() => showDialog(<SplitColumn />)}>Split text</DropdownMenuItem>
        </>
    );
}
