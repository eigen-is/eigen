// The data-validation card beside the focus cell: the prompt a validated cell carries, or the reason the value in it
// was refused. It renders from the focus cell, so arrowing onto a cell shows it and arrowing away clears it. A popover
// anchored on the cell holds it under the cell, and flips or shifts it to stay inside the grid. The selection overlay
// mounts it, and getValidationHint says what it shows and where.

import { Popover, PopoverAnchor, PopoverContent } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getValidationHint } from '../../state';

export function ValidationHintCard() {
    const { context, refs } = useContext(WorkbookContext);

    const hint = useMemo(() => {
        // The open list hangs over the same corner the card does.
        if (context.validationListOpen) return undefined;
        const last = context.selections?.[context.selections.length - 1];
        const r = last?.row_focus;
        const c = last?.column_focus;
        if (r == null || c == null) return undefined;
        return getValidationHint(context, r, c);
    }, [context]);

    if (!hint) return null;

    return (
        // Radix places the card again only for a new anchor element, so each cell gets its own.
        <Popover key={`${hint.left}_${hint.top}`} open>
            <PopoverAnchor asChild>
                <div className="absolute" style={{ left: hint.left, top: hint.top, height: hint.bottom - hint.top }} />
            </PopoverAnchor>
            <PopoverContent
                // A press on the card bubbles through React into the grid, and the class keeps it from reselecting.
                className={cn(
                    'sheet-mousedown-cancel w-max max-w-64 cursor-default select-none px-2.5 py-1.5',
                    'text-xs leading-relaxed',
                    hint.kind === 'invalid' && 'border-destructive/50',
                )}
                // Announced when the selection lands on the cell, so the explanation reaches a screen-reader user as
                // well as a sighted one.
                role="status"
                side="bottom"
                align="start"
                sideOffset={0}
                collisionBoundary={refs.cellArea.current}
                hideWhenDetached
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
            >
                {hint.kind === 'invalid' && <span className="font-medium text-destructive">{'Invalid: '}</span>}
                {hint.text}
            </PopoverContent>
        </Popover>
    );
}
