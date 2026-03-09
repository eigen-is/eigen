import {type ReactNode} from 'react';
import {cn} from '@workspace/ui/lib/utils';
import {ScrollArea} from '@workspace/ui/components/scroll-area';

type PropertiesPanelProps = {
    children: ReactNode;
    className?: string;
}

export function PropertiesPanel({children, className}: PropertiesPanelProps) {
    return (
        <div className={cn('w-64 border-l bg-background shrink-0 h-full flex flex-col overflow-hidden', className)}>
            <ScrollArea className="flex-1">
                {children}
            </ScrollArea>
        </div>
    );
}

type PropertySectionProps = {
    title: string;
    children: ReactNode;
}

export function PropertySection({title, children}: PropertySectionProps) {
    return (
        <div className="border-b px-3 py-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2.5">{title}</h4>
            <div className="space-y-2">
                {children}
            </div>
        </div>
    );
}

type PropertyRowProps = {
    label: string;
    children: ReactNode;
    className?: string;
}

export function PropertyRow({label, children, className}: PropertyRowProps) {
    return (
        <div className={cn('flex items-center gap-2', className)}>
            <span className="text-xs text-muted-foreground w-7 shrink-0">{label}</span>
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    );
}
