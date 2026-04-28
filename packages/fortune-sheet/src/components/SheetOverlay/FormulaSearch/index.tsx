import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../../context';

export const FormulaSearch: React.FC<React.HTMLAttributes<HTMLDivElement>> = (props) => {
    const { context } = useContext(WorkbookContext);
    if (context.functionCandidates.length === 0) return null;

    return (
        <div
            {...props}
            id="luckysheet-formula-search-c"
            className="absolute z-[1003] w-[300px] border border-border bg-background shadow-md text-xs"
        >
            {context.functionCandidates.map((v, index) => (
                <div
                    key={v.n}
                    className={cn('cursor-pointer px-2.5 py-1.5', index === 0 && 'border-y border-border bg-muted')}
                >
                    <div className="text-sm">{v.n}</div>
                    {index === 0 && <div className="text-muted-foreground">{v.d}</div>}
                </div>
            ))}
        </div>
    );
};
