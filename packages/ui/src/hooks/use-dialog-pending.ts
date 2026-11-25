// The submit lifecycle of every form shell and of a dialog whose action may await a mutation, such as ConfirmDialog's.
// One action runs at a time, a closing dialog runs none, and the buttons and every close path wait while one runs. It
// closes once the action succeeds, unless the action returns or resolves false, as a form check that names a field
// does. A failure keeps it open for another try: an error the mutation hook toasted ends here, and any other, such as
// a bug in a synchronous submit, is rethrown.

import { rethrowUntoasted } from '@workspace/lib/api-error';
import { useState } from 'react';

// Two promise types rather than Promise<void | false>, which Biome flags as a confusing use of void.
export type DialogAction = () => void | false | Promise<void> | Promise<false | undefined>;

// A page form passes nothing: it is always open and has nothing to close.
export function useDialogPending({
    open = true,
    onOpenChange,
}: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
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
