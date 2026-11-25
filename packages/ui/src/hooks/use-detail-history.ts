// Opens and closes a detail its page's URL names, such as a calendar event or a comment thread, with the history rule
// every detail column shares. Opening from closed pushes an entry flagged as the detail's own, so a phone's back closes
// it; a switch to another item replaces that entry; close goes back on the flagged entry and replaces anywhere else,
// such as on a deep link, so X and back do the same and back after a close never reopens the item. The host keeps the
// value in its URL and writes it through its own navigate.

import type { HistoryState } from '@tanstack/react-router';
import { useRouter } from '@tanstack/react-router';

// What a host passes on as its navigate's `state`: true keeps the entry's state, an updater writes the new entry's.
type DetailHistoryOptions = { replace: boolean; state: true | ((prev: HistoryState) => HistoryState) };

type UseDetailHistoryReturn<T> = {
    open: (next: T) => void;
    close: () => void;
};

export function useDetailHistory<T>(
    value: T | undefined,
    setValue: (next: T | undefined, options: DetailHistoryOptions) => void,
): UseDetailHistoryReturn<T> {
    const router = useRouter();
    return {
        open: (next) => {
            if (value === undefined)
                setValue(next, { replace: false, state: (prev) => ({ ...prev, detailPush: true }) });
            else setValue(next, { replace: true, state: true });
        },
        close: () => {
            if ('detailPush' in router.history.location.state) router.history.back();
            else setValue(undefined, { replace: true, state: true });
        },
    };
}
