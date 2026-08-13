import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@workspace/ui/components/collapsible';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
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

function Header({ title, summaryLines, actions }: { title: string; summaryLines?: string[]; actions?: ReactNode }) {
    return (
        <>
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
            {actions && <div className="flex items-center gap-0.5">{actions}</div>}
        </>
    );
}

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
                <InfoBlock className="px-2 py-1.5">
                    <Header title={title} summaryLines={summaryLines} actions={actions} />
                </InfoBlock>
                <div className="space-y-1">{children}</div>
            </div>
        );
    }

    return (
        <Collapsible open={open} onOpenChange={setOpen} className={className}>
            <CollapsibleTrigger asChild>
                <InfoBlock className="w-full cursor-pointer text-left px-2 py-1.5">
                    <Header title={title} summaryLines={summaryLines} />
                    <div className="flex items-center gap-0.5">
                        {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
                        <ChevronDown
                            className={cn(
                                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                                open && 'rotate-180',
                            )}
                        />
                    </div>
                </InfoBlock>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="space-y-1 pt-2">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
}
