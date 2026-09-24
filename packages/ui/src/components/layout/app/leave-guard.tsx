import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from '../../confirm-dialog';

type LeaveGuardProps = {
    active: boolean;
    title: string;
    description: string;
};

// Asks before a reload, a closed tab or an in-app navigation while `active`; the router's own beforeunload covers
// the first two, the resolver the third.
export function LeaveGuard({ active, title, description }: LeaveGuardProps) {
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
            title={title}
            description={description}
            onConfirm={() => blocker.proceed?.()}
            cancelText="Stay"
            confirmText="Leave"
            destructive
        />
    );
}
