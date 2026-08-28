import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { en, getValidationHint } from '../../state';

// The data-validation card: the prompt a validated cell carries, or the reason
// the value in it was rejected. Rendered from the focus cell, so arrowing onto
// a cell shows it and arrowing away clears it — it used to be a singleton div
// that a mousedown handler wrote with innerHTML and positioned in raw pixels.
export function ValidationHintCard() {
    const { context } = useContext(WorkbookContext);

    const hint = useMemo(() => {
        // The open list hangs over the same corner the card does.
        if (context.dataVerificationDropDownList) return undefined;
        const last = context.selections?.[context.selections.length - 1];
        const r = last?.row_focus;
        const c = last?.column_focus;
        if (r == null || c == null) return undefined;
        return getValidationHint(context, r, c);
    }, [context]);

    if (!hint) return null;

    return (
        <div
            // sheet-mousedown-cancel: clicking the card must not reselect the
            // cell underneath it. eigen-paper-chrome: popup chrome re-themes with
            // the app inside the light-pinned workbook surface (RENDERING.md
            // § Theming). pointer-events-auto: the pane region wrapper has none.
            // w-max: the pane region this renders into is a 0x0 anchor, so an
            // auto-width absolute box would wrap at min-content.
            className={cn(
                'sheet-mousedown-cancel eigen-paper-chrome pointer-events-auto absolute z-30 w-max max-w-64',
                'cursor-default select-none rounded-md border bg-popover px-2.5 py-1.5',
                'text-xs leading-relaxed text-popover-foreground shadow-md',
                hint.kind === 'invalid' && 'border-destructive/50',
            )}
            style={{ left: hint.left, top: hint.top }}
            // Announced when the selection lands on the cell, so the explanation
            // reaches a screen-reader user as well as a sighted one.
            role="status"
        >
            {hint.kind === 'invalid' && (
                <span className="font-medium text-destructive">{`${en.dataVerification.hintCard.invalidLabel} `}</span>
            )}
            {hint.text}
        </div>
    );
}
