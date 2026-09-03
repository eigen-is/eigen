import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from '../../confirm-dialog';

type UnsyncedEditsGuardProps = {
    // From useCollabDoc's `unsyncedEdits` — edits are waiting for a socket that can carry them.
    active: boolean;
};

// Collab edits live only in the tab's Y.Doc until the server acknowledges them, so leaving the
// document — reload, closed tab, or an in-app navigation — while some are pending drops them.
// The router's own beforeunload covers the first two; the resolver handles the third.
export function UnsyncedEditsGuard({ active }: UnsyncedEditsGuardProps) {
    const blocker = useBlocker({
        shouldBlockFn: () => active,
        enableBeforeUnload: () => active,
        withResolver: true,
    });

    return (
        <ConfirmDialog
            open={blocker.status === 'blocked'}
            onOpenChange={(open) => {
                if (!open) blocker.reset?.();
            }}
            title="Leave without syncing?"
            description="Edits made while offline have not reached the server yet. If you leave now they are lost."
            onConfirm={() => blocker.proceed?.()}
            cancelText="Stay"
            confirmText="Leave"
            destructive
        />
    );
}
