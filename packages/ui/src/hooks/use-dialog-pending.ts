import { useState } from 'react';

// The async-confirm lifecycle shared by every dialog whose primary action awaits a mutation: disable
// the actions in-flight (no double-submit), close only after the callback fulfils, and stay open on
// rejection so the caller's error toast reads with the retry. `handleOpenChange` blocks every close
// path (Escape/backdrop/X) while pending so the retry surface survives; opening is always allowed.
export function useDialogPending(onOpenChange: (open: boolean) => void): {
    pending: boolean;
    run: (action: () => void | Promise<void>) => Promise<void>;
    handleOpenChange: (open: boolean) => void;
} {
    const [pending, setPending] = useState(false);

    const run = async (action: () => void | Promise<void>) => {
        if (pending) return;
        setPending(true);
        try {
            await action();
            onOpenChange(false);
        } catch {
            // Stay open for retry; the mutation's onMutationError already surfaced the toast.
        } finally {
            setPending(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (open || !pending) onOpenChange(open);
    };

    return { pending, run, handleOpenChange };
}
