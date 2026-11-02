// The confirm lifecycle of a dialog whose action may await a mutation, such as ConfirmDialog's. The buttons and every
// close path wait while it runs. It closes once the action succeeds, unless the action returns or resolves false, as a
// form check that names a field does. A failure keeps it open for another try. An error the mutation hook toasted ends
// here, and any other, such as a bug in a synchronous submit, is rethrown. `closeOnRefusal` closes it on a refusal too,
// for a yes/no where another try gets the same no. A picker leaves it off, since a new name or folder gets past a 403.

import { isRefusal, wasToasted } from '@workspace/lib/api-error';
import { useState } from 'react';

export type DialogAction = () => void | false | Promise<void> | Promise<false | undefined>;

export function useDialogPending(
    onOpenChange: (open: boolean) => void,
    { closeOnRefusal = false }: { closeOnRefusal?: boolean } = {},
): {
    pending: boolean;
    run: (action: DialogAction) => Promise<void>;
    handleOpenChange: (open: boolean) => void;
} {
    const [pending, setPending] = useState(false);

    const run = async (action: DialogAction) => {
        if (pending) return;
        setPending(true);
        try {
            if ((await action()) !== false) onOpenChange(false);
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
