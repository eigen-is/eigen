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
                <div className="flex items-center justify-between min-h-[2.25rem]">
                    <h4 className="text-sm font-medium">{title}</h4>
                    {actions && <div className="flex items-center gap-0.5">{actions}</div>}
                </div>
                <div className="space-y-1">{children}</div>
            </div>
        );
    }

    return (
        <Collapsible open={open} onOpenChange={setOpen} className={className}>
            <CollapsibleTrigger className="flex items-center justify-between w-full cursor-pointer text-left rounded-md bg-muted/50 px-2 py-1.5 outline-none">
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
                <div className="flex items-center gap-0.5">
                    {/* Stop action button clicks from toggling the collapsible */}
                    {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                            open && 'rotate-180',
                        )}
                    />
                </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="space-y-1 pt-2">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
}
