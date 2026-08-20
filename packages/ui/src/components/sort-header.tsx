import { cn } from '@workspace/ui/lib/utils';
import { ArrowDown, ArrowUp } from 'lucide-react';

export type SortHeaderProps = {
    label: string;
    active: boolean;
    dir: 'asc' | 'desc';
    onClick: () => void;
    // Right-aligned headers (numeric/date columns) flush their label to the end.
    align?: 'left' | 'right';
    // Display + spacing utilities the caller controls (container-query visibility, padding).
    className?: string;
};

// Presentational column header button used by the grid-based tables (drive, admin users).
// Callers own the sort state; this only renders the label + active-direction arrow. Display
// (and container-query visibility) comes in via className so the header collapses with its cells.
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
