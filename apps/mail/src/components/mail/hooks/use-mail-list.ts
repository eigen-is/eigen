import type { EmailSummary } from '@workspace/lib/types/mail';
import { type UseListSelectionReturn, useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { useEffect, useMemo, useState } from 'react';

type UseMailListOptions = {
    emails: EmailSummary[];
    searchQuery: string;
    activeId?: string;
};

type UseMailListReturn = {
    orderedEmails: EmailSummary[];
    selection: UseListSelectionReturn<EmailSummary>;
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
};

// Single source of truth for the thread-list's ordered data, selection, and
// keyboard cursor. Owned by MailRoute so the list AND (Phase 2) useMailShortcuts
// act on the same rows. Lifted out of EmailList; behaviour matches the shared
// useKeyboardListNavigation it replaces for mail.
export function useMailList({ emails, searchQuery, activeId }: UseMailListOptions): UseMailListReturn {
    // Filter + sort lifted verbatim from EmailList — same case-insensitive
    // subject/fromShort/textShort match, same date-desc sort.
    const orderedEmails = useMemo(() => {
        const queryLower = searchQuery.toLowerCase();
        return [...emails]
            .filter(
                (email) =>
                    email.subject.toLowerCase().includes(queryLower) ||
                    email.fromShort.toLowerCase().includes(queryLower) ||
                    email.textShort.toLowerCase().includes(queryLower),
            )
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [emails, searchQuery]);

    const selection = useListSelection({ items: orderedEmails, getId: (e) => e.id });

    const [cursorIndex, setCursorIndex] = useState(-1);

    // Cursor↔activeId sync — parity with use-keyboard-list-navigation.ts (43-52):
    // an open row drives the cursor to its index; no open row resets to -1. Runs
    // on every orderedEmails change, matching the shared hook's [activeId, items].
    useEffect(() => {
        if (activeId && orderedEmails.length > 0) {
            const index = orderedEmails.findIndex((e) => e.id === activeId);
            if (index !== -1) setCursorIndex(index);
        } else {
            setCursorIndex(-1);
        }
    }, [activeId, orderedEmails]);

    // Keep the cursor in range when the list shrinks (filter change / delete) —
    // the shared hook left a stale index that could read past the end.
    useEffect(() => {
        if (cursorIndex > orderedEmails.length - 1) {
            setCursorIndex(orderedEmails.length - 1);
        }
    }, [orderedEmails.length, cursorIndex]);

    return { orderedEmails, selection, cursorIndex, setCursorIndex };
}
