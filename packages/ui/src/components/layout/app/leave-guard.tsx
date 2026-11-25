// Asks before unsaved work is dropped, such as a page form's draft or a Drive text file's edits, while `active` says
// something is at risk. An in-app navigation waits on a Stay or Leave question through the router's blocker, and a
// reload or a closed tab gets the browser's own prompt through its beforeunload. A host renders it beside the work it
// guards.

import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ConfirmDialog } from '../../confirm-dialog';

type LeaveGuardProps = {
    active: boolean;
    title: string;
    description: string;
};

export function LeaveGuard({ active, title, description }: LeaveGuardProps) {
    const blocker = useBlocker({
        shouldBlockFn: () => active,
        enableBeforeUnload: () => active,
        withResolver: true,
    });

    // Nothing is at risk any more while it asks, such as after a save landed or its page unmounted, so the click that
    // asked goes on instead of being dropped.
    useEffect(() => {
        if (blocker.status !== 'blocked') return;
        if (!active) blocker.proceed();
        return () => blocker.proceed();
    }, [blocker, active]);

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
