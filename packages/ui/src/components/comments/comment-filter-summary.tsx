import { COMMENT_STATUS_LABELS, type useCommentFilter } from '@workspace/lib/comments';
import { useResolvedUser } from '@workspace/lib/public';

type FilterSummaryProps = {
    filter: ReturnType<typeof useCommentFilter>;
    onClear: () => void;
    // Toolbar hosts render bare inline text; the panel uses the full-width strip (default).
    inline?: boolean;
};

// One-line human summary of the active filter, e.g. "Open · assigned to me".
export function FilterSummary({ filter, onClear, inline = false }: FilterSummaryProps) {
    const { assignee, colors, status } = filter.filter;
    const memberEmail = typeof assignee === 'object' ? assignee.email : '';
    const { displayName } = useResolvedUser({ email: memberEmail });

    // Status always leads ("Open · assigned to me") so the strip describes what the list
    // shows, not just the deltas from the defaults.
    const parts: string[] = [COMMENT_STATUS_LABELS[status]];
    if (assignee === 'me') parts.push('assigned to me');
    else if (assignee === 'unassigned') parts.push('unassigned');
    else if (typeof assignee === 'object') parts.push(`assigned to ${displayName || memberEmail.split('@')[0]}`);
    if (colors) parts.push(`${colors.size} color${colors.size === 1 ? '' : 's'}`);

    return (
        <div
            className={
                inline
                    ? 'flex items-center gap-2 text-[11px] text-muted-foreground'
                    : 'flex items-center justify-between gap-2 border-b bg-primary/5 px-3 py-1 text-[11px] text-primary'
            }
        >
            <span className="truncate">{parts.join(' · ')}</span>
            <button type="button" className="shrink-0 font-medium hover:underline" onClick={onClear}>
                Clear
            </button>
        </div>
    );
}
