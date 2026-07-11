import { useCallback, useMemo, useState } from 'react';
import type { CommentEntry } from '../../types/chat';
import type { CommentCard } from '../../types/comments';

export type CommentAssigneeFilter = 'all' | 'me' | 'unassigned' | { email: string };

export type CommentFilter = {
    assignee: CommentAssigneeFilter;
    colors: Set<string> | null; // null = all; matches card.color || ''
    status: 'open' | 'resolved' | 'all';
};

export const DEFAULT_COMMENT_FILTER: CommentFilter = { assignee: 'all', colors: null, status: 'open' };

export const COMMENT_STATUS_LABELS: Record<CommentFilter['status'], string> = {
    open: 'Open',
    resolved: 'Resolved',
    all: 'All',
};

function sameAssignee(a: CommentAssigneeFilter, b: CommentAssigneeFilter): boolean {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    return a.email === b.email;
}

function sameColors(a: Set<string> | null, b: Set<string> | null): boolean {
    if (!a || !b) return a === b;
    return a.size === b.size && [...a].every((c) => b.has(c));
}

export function isCommentFilterActive(filter: CommentFilter, defaults: CommentFilter): boolean {
    return (
        filter.status !== defaults.status ||
        !sameAssignee(filter.assignee, defaults.assignee) ||
        !sameColors(filter.colors, defaults.colors)
    );
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

export function useCommentFilter(defaults?: Partial<CommentFilter>): {
    filter: CommentFilter;
    setAssignee: (a: CommentAssigneeFilter) => void;
    toggleColor: (color: string) => void;
    setStatus: (s: CommentFilter['status']) => void;
    isActive: boolean;
    clear: () => void;
} {
    const [mergedDefaults] = useState<CommentFilter>(() => ({ ...DEFAULT_COMMENT_FILTER, ...defaults }));
    const [filter, setFilter] = useState(mergedDefaults);

    const setAssignee = useCallback((a: CommentAssigneeFilter) => setFilter((f) => ({ ...f, assignee: a })), []);
    const setStatus = useCallback((s: CommentFilter['status']) => setFilter((f) => ({ ...f, status: s })), []);
    const toggleColor = useCallback(
        (color: string) =>
            setFilter((f) => {
                const next = new Set(f.colors);
                if (next.has(color)) next.delete(color);
                else next.add(color);
                return { ...f, colors: next.size ? next : null };
            }),
        [],
    );
    const clear = useCallback(() => setFilter(mergedDefaults), [mergedDefaults]);

    const isActive = useMemo(() => isCommentFilterActive(filter, mergedDefaults), [filter, mergedDefaults]);

    return { filter, setAssignee, toggleColor, setStatus, isActive, clear };
}
