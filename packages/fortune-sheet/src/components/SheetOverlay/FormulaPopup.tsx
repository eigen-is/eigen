import { Popover, PopoverAnchor, PopoverContent } from '@workspace/ui/components/popover';
import type { ReactNode } from 'react';
import { useLayoutEffect, useState } from 'react';

type FormulaPopupProps = {
    anchorRef: { readonly current: HTMLElement | null };
    open: boolean;
    children: ReactNode;
};

// Shared wrapper for the formula autocomplete (FormulaSearch) and function-signature hint
// (FormulaHint) popups. Anchors a Radix Popover to the cell/formula-bar input via a fixed-position
// virtual element, so the popup escapes the editor's z-index stacking context (z-19) and the
// scrollbar siblings (z-1003).
export function FormulaPopup({ anchorRef, open, children }: FormulaPopupProps) {
    const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

    useLayoutEffect(() => {
        if (!open) {
            setRect(null);
            return;
        }
        const update = () => {
            const r = anchorRef.current?.getBoundingClientRect();
            if (r) setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [open, anchorRef]);

    if (!open || !rect) return null;

    return (
        <Popover open>
            <PopoverAnchor asChild>
                <div
                    style={{
                        position: 'fixed',
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                        pointerEvents: 'none',
                    }}
                />
            </PopoverAnchor>
            <PopoverContent
                side="bottom"
                align="start"
                sideOffset={4}
                className="luckysheet-mousedown-cancel w-80 max-h-[300px] overflow-y-auto p-0"
                style={{ zIndex: 1010 }}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
            >
                {children}
            </PopoverContent>
        </Popover>
    );
}
