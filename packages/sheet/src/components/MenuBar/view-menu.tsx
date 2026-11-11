// The menu bar's View menu: freezing rows and columns at the selection, and showing a hidden sheet again. Each row runs
// its action on the workbook.

import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { EyeOff, Snowflake } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import type { Context } from '../../state';
import { api, handleFreeze } from '../../state';

export function ViewMenu() {
    const { context, setContext } = useContext(WorkbookContext);

    const dispatch = (fn: (ctx: Context) => void) => () => setContext(fn);

    const hidden = context.sheets.filter((s) => s.hide === 1);

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <Snowflake className="h-4 w-4" /> Freeze
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-cancel'))}>
                        Cancel freezing
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-row'))}>
                        Freeze to current row
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-col'))}>
                        Freeze to current column
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-row-col'))}>
                        Freeze to current cell
                    </DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            {hidden.length > 0 && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <EyeOff className="h-4 w-4" /> Hidden sheets
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            {hidden.map((sheet) => (
                                <DropdownMenuItem
                                    key={sheet.id}
                                    onClick={() => setContext((draftCtx) => api.showSheet(draftCtx, sheet.id))}
                                >
                                    {sheet.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </>
            )}
        </>
    );
}
