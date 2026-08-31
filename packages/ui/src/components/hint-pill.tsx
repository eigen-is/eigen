import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

type HintPillProps = {
    // Placement classes (e.g. "bottom-3 left-1/2 -translate-x-1/2") — the pill is absolute, the caller anchors it.
    className?: string;
    // When given, the pill is a clickable readout (vector's zoom reset); otherwise a passive hint.
    onClick?: () => void;
    title?: string;
    children: ReactNode;
};

// Small floating pill over a canvas/work surface: a transient gesture hint or a compact readout.
// Interactive pills swallow pointerdown so the surface underneath doesn't start a gesture.
export function HintPill({ className, onClick, title, children }: HintPillProps) {
    const base = 'absolute z-10 rounded-md border bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow-sm';
    if (onClick) {
        return (
            <button
                type="button"
                className={cn(base, 'hover:text-foreground', className)}
                title={title}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onClick}
            >
                {children}
            </button>
        );
    }
    return <div className={cn(base, 'pointer-events-none', className)}>{children}</div>;
}
