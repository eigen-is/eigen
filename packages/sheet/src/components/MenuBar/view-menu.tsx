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
import { en, handleFreeze } from '../../state';
import { showSheet } from '../../state/api/sheet';

export function ViewMenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { freezen } = en;

    const dispatch = (fn: (ctx: Context) => void) => () => setContext((draftCtx) => fn(draftCtx));

    const hidden = context.sheets.filter((s): s is typeof s & { id: string } => s.hide === 1 && s.id != null);

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>{freezen.default}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="sheet-mousedown-cancel">
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-cancel'))}>
                        {freezen.freezenCancel}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-row'))}>
                        {freezen.freezenRowRange}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-col'))}>
                        {freezen.freezenColumnRange}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={dispatch((ctx) => handleFreeze(ctx, 'freeze-row-col'))}>
                        {freezen.freezenRCRange}
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
