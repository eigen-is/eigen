import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar/toolbar-title';
import { ScrollArea } from '@workspace/ui/components/scroll-area';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

// The w-64 below, for hosts that have to lay out around this panel.
export const PROPERTIES_PANEL_WIDTH_PX = 256;

// Section order is a cross-app convention, not a runtime sort — every host (vector, slides, docs,
// sheets) authors its sections in this sequence so the panel reads the same everywhere:
//
//   1. geometry     Transform / Layout
//   2. content      Text · Spacing · Image
//   3. paint        Fill / Color / Background · Stroke / Border · Shape · Arrowheads · Sketch
//   4. appearance   Appearance
//   5. actions      Arrange · Align
//   6. destructive  Delete
//
// Titles are literals and the host guards only filter, so authored order IS rendered order — which
// keeps DOM order (and with it tab order) matched to what the eye sees. A new section slots into its
// group; a group a panel doesn't have is simply absent.

type PropertiesPanelProps = {
    children: ReactNode;
    // Fixed title bar, pixel-matched to the comments/activity Column toolbar (h-12 + ToolbarTitle).
    title?: ReactNode;
    className?: string;
};

export function PropertiesPanel({ title, children, className }: PropertiesPanelProps) {
    return (
        <div className={cn('w-64 border-l bg-background shrink-0 h-full flex flex-col overflow-hidden', className)}>
            {title && (
                <div className="h-12 flex items-center app-gutter-x shrink-0 border-b">
                    <ToolbarTitle>{title}</ToolbarTitle>
                </div>
            )}
            {/* min-h-0: the auto minimum would otherwise hold this at the full panel height, hanging the title bar's worth of content below the clip. */}
            {/* Radix wraps viewport children in display:table (min-width:100%), which sizes to content and defeats truncate in this fixed-width panel — force block. */}
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
        <div className="border-b px-3 py-3">
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
// inputs, selects, colour swatches and toggle groups all start on the same vertical line.
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
