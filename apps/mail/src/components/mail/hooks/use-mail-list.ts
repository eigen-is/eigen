import type { EmailSummary } from '@workspace/lib/types/mail';
import { type UseListSelectionReturn, useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

    // Cursor tracked by email ID, not a bare index, so it stays on its row across sort/filter/
    // new-mail changes — a raw index silently points at a different email once the list mutates,
    // and o/x would then act on the wrong one. cursorIndex is derived; setCursorIndex maps an
    // index back to its id for the keydown/shortcut callers.
    const [cursorId, setCursorId] = useState<string | undefined>(undefined);
    const cursorIndex = useMemo(
        () => (cursorId ? orderedEmails.findIndex((e) => e.id === cursorId) : -1),
        [cursorId, orderedEmails],
    );
    const setCursorIndex = useCallback(
        (index: number) => {
            setCursorId(index >= 0 && index < orderedEmails.length ? orderedEmails[index].id : undefined);
        },
        [orderedEmails],
    );

    // Move the cursor to a conversation only when it newly opens (activeId transition), not on
    // every orderedEmails change, so j/k moves freely while one stays open. Clearing activeId
    // keeps the cursor put (Gmail model). prevActiveId advances only once the row is located, so
    // a deep-link whose email arrives a tick later still syncs.
    const prevActiveId = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (activeId === prevActiveId.current) return;
        if (!activeId) {
            prevActiveId.current = activeId;
            return;
        }
        if (orderedEmails.some((e) => e.id === activeId)) {
            setCursorId(activeId);
            prevActiveId.current = activeId;
        }
    }, [activeId, orderedEmails]);

    return { orderedEmails, selection, cursorIndex, setCursorIndex };
}
