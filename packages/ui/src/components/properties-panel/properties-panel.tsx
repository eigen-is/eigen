// The frame every properties panel shares, such as Slides' or Docs' selection panel: a small fixed-width column at
// the right with an optional title bar and one scroller, and the section and row grammar the panels are written in.

import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar/toolbar-title';
import { ScrollArea } from '@workspace/ui/components/scroll-area';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { columnWidthPx } from '../layout/app/column-widths';

type PropertiesPanelProps = {
    children: ReactNode;
    // Fixed title bar, pixel-matched to the comments/activity Column toolbar (h-12 + ToolbarTitle).
    title?: ReactNode;
};

export function PropertiesPanel({ title, children }: PropertiesPanelProps) {
    return (
        <div
            className="border-l bg-background shrink-0 h-full flex flex-col overflow-hidden"
            style={{ width: columnWidthPx('small') }}
        >
            {title && (
                <div className="h-12 flex items-center app-gutter-x shrink-0 border-b">
                    <ToolbarTitle>{title}</ToolbarTitle>
                </div>
            )}
            {/* min-h-0, or the auto minimum holds this at the panel's full height below the title bar. Radix wraps the
                viewport's children in display: table, which sizes to content and defeats truncate, so force block. */}
            <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
                {children}
            </ScrollArea>
        </div>
    );
}

type PropertySectionProps = {
    title: string;
    children: ReactNode;
};

export function PropertySection({ title, children }: PropertySectionProps) {
    return (
        <div className="border-b app-gutter">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2.5">{title}</h4>
            <div className="space-y-2">{children}</div>
        </div>
    );
}

type PropertyRowProps = {
    label: string;
    children: ReactNode;
    className?: string;
    // Single-letter labels (X/Y/W/H) in a two-column grid, where the full label column would starve the input.
    compact?: boolean;
};

// One row grammar for every panel: a fixed label column and the control filling the rest, so number
// inputs, selects, color swatches and toggle groups all start on the same vertical line.
export function PropertyRow({ label, children, className, compact }: PropertyRowProps) {
    return (
        <div className={cn('flex items-center gap-2', className)}>
            <span className={cn('text-xs text-muted-foreground shrink-0 truncate', compact ? 'w-5' : 'w-14')}>
                {label}
            </span>
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    );
}
