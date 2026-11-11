// The filter on a document's comment list: which assignee, colors and status it shows. useCommentFilter holds one
// host's choice and knows whether it differs from that host's defaults, and matchesCommentFilter says whether a
// card passes. A host such as an editor owns the state and hands it to the comment panel and the filter menu.

import { useCallback, useMemo, useState } from 'react';
import type { CommentEntry } from '../../types/chat';
import type { CommentCard } from '../../types/comments';

export type CommentAssigneeFilter = 'all' | 'me' | 'unassigned' | { email: string };

// In the Status submenu's order.
export const COMMENT_STATUS_FILTERS = ['open', 'resolved', 'all'] as const;

export type CommentFilter = {
    assignee: CommentAssigneeFilter;
    colors: Set<string> | null; // null = all; matches card.color || ''
    status: (typeof COMMENT_STATUS_FILTERS)[number];
};

export const DEFAULT_COMMENT_FILTER: CommentFilter = { assignee: 'all', colors: null, status: 'open' };

export const COMMENT_STATUS_LABELS: Record<CommentFilter['status'], string> = {
    open: 'Open',
    resolved: 'Resolved',
    all: 'All',
};

export function useCommentFilter(defaults?: Partial<CommentFilter>): {
    filter: CommentFilter;
    setAssignee: (assignee: CommentAssigneeFilter) => void;
    toggleColor: (color: string) => void;
    setStatus: (status: CommentFilter['status']) => void;
    isActive: boolean;
    clear: () => void;
} {
    const [initial] = useState<CommentFilter>(() => ({ ...DEFAULT_COMMENT_FILTER, ...defaults }));
    const [filter, setFilter] = useState(initial);

    const setAssignee = useCallback(
        (assignee: CommentAssigneeFilter) => setFilter((current) => ({ ...current, assignee })),
        [],
    );
    const setStatus = useCallback(
        (status: CommentFilter['status']) => setFilter((current) => ({ ...current, status })),
        [],
    );
    const toggleColor = useCallback(
        (color: string) =>
            setFilter((current) => {
                const colors = new Set(current.colors);
                if (colors.has(color)) colors.delete(color);
                else colors.add(color);
                return { ...current, colors: colors.size ? colors : null };
            }),
        [],
    );
    const clear = useCallback(() => setFilter(initial), [initial]);

    const isActive = useMemo(() => isCommentFilterActive(filter, initial), [filter, initial]);

    return { filter, setAssignee, toggleColor, setStatus, isActive, clear };
}

export function matchesCommentFilter(
    card: CommentCard,
    entry: CommentEntry | undefined,
    filter: CommentFilter,
    currentUserEmail: string,
): boolean {
    // Missing entry = unseeded card: open and unassigned.
    const status = entry?.status ?? 'open';
    if (filter.status !== 'all' && status !== filter.status) return false;

    const assignee = entry?.assignee ?? null;
    if (filter.assignee === 'me' && assignee !== currentUserEmail.toLowerCase()) return false;
    if (filter.assignee === 'unassigned' && assignee !== null) return false;
    if (typeof filter.assignee === 'object' && assignee !== filter.assignee.email) return false;

    if (filter.colors && !filter.colors.has(card.color || '')) return false;
    return true;
}

export function isCommentFilterActive(filter: CommentFilter, defaults: CommentFilter): boolean {
    return (
        filter.status !== defaults.status ||
        !sameAssignee(filter.assignee, defaults.assignee) ||
        !sameColors(filter.colors, defaults.colors)
    );
}

function sameAssignee(a: CommentAssigneeFilter, b: CommentAssigneeFilter): boolean {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    return a.email === b.email;
}

function sameColors(a: Set<string> | null, b: Set<string> | null): boolean {
    if (!a || !b) return a === b;
    return a.size === b.size && [...a].every((color) => b.has(color));
}
