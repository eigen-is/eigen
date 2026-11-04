// Opens the comment a landing names, such as the `?chat=` of a notification's link or the `?card=` of a copied card
// link. It waits until the host is ready, so the comment opens in the state the host shows it in, live or deleted.
// `open` says whether the name found a comment. A name that found none calls `onNotFound`, so the host can drop the
// parameter. A new name in the URL resolves again.

import { useEffect, useRef } from 'react';

export function useOpenOnLanding(
    name: string | undefined,
    open: (name: string) => boolean,
    options: { ready: boolean; onNotFound?: () => void },
): void {
    const appliedRef = useRef<string | undefined>(undefined);
    const { ready, onNotFound } = options;
    useEffect(() => {
        if (!name) {
            appliedRef.current = undefined;
            return;
        }
        if (!ready || appliedRef.current === name) return;
        appliedRef.current = name;
        if (!open(name)) onNotFound?.();
    }, [name, ready, open, onNotFound]);
}
