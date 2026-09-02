import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import type { Context } from '../../state';
import { handleFreeze } from '../../state';
import { showSheet } from '../../state/api/sheet';

export function ViewMenu() {
    const { context, setContext } = useContext(WorkbookContext);

    const dispatch = (fn: (ctx: Context) => void) => () => setContext((draftCtx) => fn(draftCtx));

    const hidden = context.sheets.filter((s): s is typeof s & { id: string } => s.hide === 1 && s.id != null);

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>Freeze</DropdownMenuSubTrigger>
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
                        <DropdownMenuSubTrigger>Hidden sheets</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            {hidden.map((sheet) => (
                                <DropdownMenuItem
                                    key={sheet.id}
                                    onClick={() => setContext((draftCtx) => showSheet(draftCtx, sheet.id))}
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
