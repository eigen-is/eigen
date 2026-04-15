import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@workspace/ui/components/collapsible';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

type CollapsibleUserListProps = {
    title: string;
    summaryLines?: string[];
    actions?: ReactNode;
    collapseThreshold?: number;
    count: number;
    children: ReactNode;
    className?: string;
};

export function CollapsibleUserList({
    title,
    summaryLines,
    actions,
    collapseThreshold = 3,
    count,
    children,
    className,
}: CollapsibleUserListProps) {
    const collapsible = count > collapseThreshold;
    const [open, setOpen] = useState(!collapsible);

    // Collapse when count crosses the threshold (e.g. after async data loads)
    useEffect(() => {
        if (collapsible) setOpen(false);
    }, [collapsible]);

    if (!collapsible) {
        return (
            <div className={cn('space-y-2', className)}>
                <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">{title}</h4>
                    {actions && <div className="flex items-center gap-0.5">{actions}</div>}
                </div>
                <div className="space-y-1">{children}</div>
            </div>
        );
    }

    return (
        <Collapsible open={open} onOpenChange={setOpen} className={className}>
            <div className="flex items-start justify-between">
                <CollapsibleTrigger className="flex items-start cursor-pointer text-left">
                    <div>
                        <h4 className="text-sm font-medium">{title}</h4>
                        {summaryLines && summaryLines.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                                {summaryLines.map((line) => (
                                    <div key={line}>{line}</div>
                                ))}
                            </div>
                        )}
                    </div>
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 ml-1 mt-0.5 shrink-0 text-muted-foreground transition-transform duration-200',
                            open && 'rotate-180',
                        )}
                    />
                </CollapsibleTrigger>
                {actions && <div className="flex items-center gap-0.5">{actions}</div>}
            </div>
            <CollapsibleContent>
                <div className="space-y-1 pt-2">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
}
