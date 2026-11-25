// The submit lifecycle of every form shell and of a dialog whose action may await a mutation, such as ConfirmDialog's.
// One action runs at a time, and the buttons and every close path wait while it does. It closes once the action
// succeeds, unless the action returns or resolves false, as a form check that names a field does; a page form has
// nothing to close. A failure keeps it open for another try. An error the mutation hook toasted ends here, and any
// other, such as a bug in a synchronous submit, is rethrown. `closeOnRefusal` closes it on a refusal too, for a yes/no
// where another try gets the same no. A picker leaves it off, since a new name or folder gets past a 403.

import { isRefusal, rethrowUntoasted } from '@workspace/lib/api-error';
import { useState } from 'react';

// Two promise types rather than Promise<void | false>, which Biome flags as a confusing use of void.
export type DialogAction = () => void | false | Promise<void> | Promise<false | undefined>;

// A page form passes nothing: it is always open and has nothing to close.
export function useDialogPending({
    open = true,
    onOpenChange,
    closeOnRefusal = false,
}: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    closeOnRefusal?: boolean;
} = {}): {
    pending: boolean;
    // Resolves false when the action did, so a form can point at the field its check refused.
    run: (action: DialogAction) => Promise<false | undefined>;
    handleOpenChange: (open: boolean) => void;
} {
    const [pending, setPending] = useState(false);

    const run = async (action: DialogAction) => {
        // A closing dialog stays mounted while it fades out, with the focus still in its field.
        if (pending || !open) return;
        setPending(true);
        try {
            if ((await action()) === false) return false;
            onOpenChange?.(false);
        } catch (error) {
            if (closeOnRefusal && isRefusal(error)) onOpenChange?.(false);
            // Swallowing an error no toast has shown would leave the user with a button that does nothing.
            rethrowUntoasted(error);
        } finally {
            setPending(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (open || !pending) onOpenChange?.(open);
    };

    return { pending, run, handleOpenChange };
}
