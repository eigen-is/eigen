// The confirm lifecycle of a dialog whose action awaits a mutation, such as ConfirmDialog's: the buttons and every
// close path wait while it runs, and it closes once the action succeeds. A failure keeps it open beside the error toast
// for another try, unless the server refused, such as a team it won't delete: another try gets the same no.

import { isRefusal } from '@workspace/lib/api-error';
import { useState } from 'react';

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
        } catch (error) {
            // The mutation's onMutationError already surfaced the toast.
            if (isRefusal(error)) onOpenChange(false);
        } finally {
            setPending(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (open || !pending) onOpenChange(open);
    };

    return { pending, run, handleOpenChange };
}
