// The header row of the grid-based lists, such as Drive's file table and the Admin app's users and
// teams: column headers that sort on a click, and the row that keeps them in view. Callers own the
// sort state and the grid columns.

import { cn } from '@workspace/ui/lib/utils';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

// The sort-toggle rule the headers and the sort menus share. Selecting the active column again flips
// its direction. Switching to another column uses that column's default direction.
export function nextSortDir<K extends string>(
    key: K,
    activeKey: K,
    dir: SortDir,
    defaults: Record<K, SortDir>,
): { key: K; dir: SortDir } {
    return key === activeKey ? { key, dir: dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaults[key] };
}

export type SortHeaderProps = {
    label: string;
    active: boolean;
    dir: SortDir;
    onClick: () => void;
    // Right-aligned headers (numeric/date columns) flush their label to the end.
    align?: 'left' | 'right';
    // Display + spacing utilities the caller controls (container-query visibility, padding).
    className?: string;
};

// One column header: the label and, on the active column, the direction arrow. Display and
// container-query visibility come in via className, so the header collapses with its cells.
export function SortHeader({ label, active, dir, onClick, align = 'left', className }: SortHeaderProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'eigen-section-label h-10 items-center gap-1 hover:text-foreground',
                align === 'right' ? 'justify-end text-right' : 'text-left',
                className,
            )}
        >
            <span className="truncate">{label}</span>
            {active &&
                (dir === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)}
        </button>
    );
}

// The row of column headers, which stays at the top while the rows scroll under it. It sits on the
// in-content layer, so the positioned parts of a row, such as an avatar, pass under it.
export function SortHeaderRow({ className, children }: { className: string; children: ReactNode }) {
    return (
        <div className={cn('grid border-b app-gutter-x sticky top-0 z-10 bg-background', className)}>{children}</div>
    );
}
