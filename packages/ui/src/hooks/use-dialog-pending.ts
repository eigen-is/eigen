// The confirm lifecycle of a dialog whose action may await a mutation, such as ConfirmDialog's: the buttons and every
// close path wait while it runs, and it closes once the action succeeds. A failure keeps it open for another try. An
// error the mutation hook toasted ends here; any other, such as a bug in a synchronous submit, is rethrown to the caller.
// `closeOnRefusal` is for a yes/no with nothing to edit: another try gets the same no, so a refusal closes it. A picker
// leaves it off, since its typed name or chosen folder is how the user gets past a 403 or 422.

import { isRefusal, wasToasted } from '@workspace/lib/api-error';
import { useState } from 'react';

export function useDialogPending(
    onOpenChange: (open: boolean) => void,
    { closeOnRefusal = false }: { closeOnRefusal?: boolean } = {},
): {
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
            if (closeOnRefusal && isRefusal(error)) onOpenChange(false);
            // Swallowing an error no toast has shown would leave the user with a button that does nothing.
            if (!wasToasted(error)) throw error;
        } finally {
            setPending(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (open || !pending) onOpenChange(open);
    };

    return { pending, run, handleOpenChange };
}
