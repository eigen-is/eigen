import { useScrollToIndex } from '@workspace/ui/hooks/use-scroll-to-index';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useEffect, useMemo, useRef } from 'react';
import { WorkbookContext } from '../../../context';
import { FormulaPopup } from '../FormulaPopup';

type FormulaSearchProps = {
    anchorRef: { readonly current: HTMLElement | null };
    open: boolean;
    selectedIndex: number;
    onSelect: (formulaName: string) => void;
    onItemsChange: (count: number, names: string[]) => void;
};

export function FormulaSearch({ anchorRef, open, selectedIndex, onSelect, onItemsChange }: FormulaSearchProps) {
    const { context } = useContext(WorkbookContext);
    const listRef = useRef<HTMLUListElement>(null);
    useScrollToIndex(listRef, selectedIndex);

    const items = context.functionCandidates;
    const names = useMemo(() => items.map((i) => i.n), [items]);

    useEffect(() => {
        onItemsChange(names.length, names);
    }, [names, onItemsChange]);

    return (
        <FormulaPopup anchorRef={anchorRef} open={open && items.length > 0}>
            <ul ref={listRef} tabIndex={-1}>
                {items.map((v, index) => {
                    const isActive = index === selectedIndex;
                    return (
                        <li
                            key={v.n}
                            className={cn('px-2.5 py-1.5 eigen-list-item', isActive && 'eigen-list-item-active')}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                onSelect(v.n);
                            }}
                        >
                            <div className="text-sm">{v.n}</div>
                            {isActive && v.d && <div className="text-xs text-muted-foreground">{v.d}</div>}
                        </li>
                    );
                })}
            </ul>
        </FormulaPopup>
    );
}
