import { ScrollArea } from '@workspace/ui/components/scroll-area';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

// The w-64 below, for hosts that have to lay out around this panel.
export const PROPERTIES_PANEL_WIDTH_PX = 256;

type PropertiesPanelProps = {
    children: ReactNode;
    className?: string;
};

export function PropertiesPanel({ children, className }: PropertiesPanelProps) {
    return (
        <div className={cn('w-64 border-l bg-background shrink-0 h-full flex flex-col overflow-hidden', className)}>
            {/* Radix wraps viewport children in display:table (min-width:100%), which sizes to content and defeats truncate in this fixed-width panel — force block. */}
            <ScrollArea className="flex-1 h-full [&_[data-slot=scroll-area-viewport]>div]:!block">
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
};

export function PropertyRow({ label, children, className }: PropertyRowProps) {
    return (
        <div className={cn('flex items-center gap-2', className)}>
            <span className="text-xs text-muted-foreground w-7 shrink-0">{label}</span>
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    );
}
