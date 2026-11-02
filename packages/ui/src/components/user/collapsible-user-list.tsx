// A list of people under a header bar with a title, a summary and optional actions, such as an event's guests or who
// can open a Drive item. A list longer than its threshold starts collapsed, and the title is a button that opens and
// closes it. That button's hit area stretches over the whole bar, while the actions stay buttons of their own above it.

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@workspace/ui/components/collapsible';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { InfoBlock } from '../info-block';

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

    // A list can cross the threshold after it rendered, such as when its people load, and then it starts collapsed.
    useEffect(() => {
        if (collapsible) setOpen(false);
    }, [collapsible]);

    if (!collapsible) {
        return (
            <div className={cn('space-y-2', className)}>
                <InfoBlock className="px-2 py-1.5">
                    <Header title={title} summaryLines={summaryLines} />
                    {actions && <div className="flex items-center gap-0.5">{actions}</div>}
                </InfoBlock>
                <div className="space-y-1">{children}</div>
            </div>
        );
    }

    // The actions come after the trigger and are positioned too, so they paint above its stretched hit area. The
    // focus ring sits inside the bar, because a list in a scrolling container would clip a ring outside it.
    return (
        <Collapsible open={open} onOpenChange={setOpen} className={className}>
            <InfoBlock className="relative px-2 py-1.5">
                <Header
                    title={
                        <CollapsibleTrigger className="cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 focus-visible:after:ring-inset">
                            {title}
                        </CollapsibleTrigger>
                    }
                    summaryLines={summaryLines}
                />
                <div className="flex items-center gap-0.5">
                    {actions && <div className="relative flex items-center gap-0.5">{actions}</div>}
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                            open && 'rotate-180',
                        )}
                    />
                </div>
            </InfoBlock>
            <CollapsibleContent>
                <div className="space-y-1 pt-2">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
}

function Header({ title, summaryLines }: { title: ReactNode; summaryLines?: string[] }) {
    return (
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
    );
}
