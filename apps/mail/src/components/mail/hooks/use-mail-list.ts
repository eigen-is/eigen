// The message list's rows in the order they show, its selection and its keyboard cursor, in one hook. The mail route
// owns it, so the list it draws and the shortcuts it handles act on the same rows.

import type { EmailSummary } from '@workspace/lib/types/mail';
import type { UseListSelectionReturn } from '@workspace/ui/hooks/use-list-selection';
import { useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type UseMailListOptions = {
    emails: readonly EmailSummary[];
    activeId?: string;
};

type UseMailListReturn = {
    orderedEmails: EmailSummary[];
    selection: UseListSelectionReturn<EmailSummary>;
    cursorIndex: number;
    setCursorIndex: (index: number) => void;
    setCursorById: (id: string | undefined) => void;
};

export function useMailList({ emails, activeId }: UseMailListOptions): UseMailListReturn {
    // The server's order, newest received first and then id, over the loaded pages or the search hits, so a
    // search ranked by relevance reads like the list and a page boundary never moves.
    const orderedEmails = useMemo(() => {
        return [...emails].sort(
            (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
    }, [emails]);

    const selection = useListSelection({ items: orderedEmails, getId: (e) => e.id });

    // Kept by id, not index: an index points at another message once the list changes, and o or x would act on it.
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

    // Only a message that newly opens moves the cursor, so j and k move freely while one stays open. The ref advances
    // once the row is found, so a deep link whose message loads a tick later still lands.
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

    return { orderedEmails, selection, cursorIndex, setCursorIndex, setCursorById: setCursorId };
}
