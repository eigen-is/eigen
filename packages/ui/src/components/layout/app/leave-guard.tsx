// Asks before unsaved work is dropped, such as a page form's draft or a Drive text file's edits, while `active` says
// something is at risk, a save that runs included, since it may fail. An in-app navigation waits on "Discard changes?"
// through the router's blocker, and a reload or a closed tab gets the browser's own prompt through its beforeunload. A
// save's own navigation passes with ignoreBlocker. A host renders it beside the work it guards.

import { useBlocker } from '@tanstack/react-router';
import type { ComponentProps } from 'react';
import { useEffect } from 'react';
import { DISCARD_CHANGES_QUESTION } from '../../../hooks/use-discard-changes';
import { ConfirmDialog } from '../../confirm-dialog';

type LeaveGuardProps = {
    active: boolean;
    // For work that is not a form's draft, such as edits made offline.
    question?: Pick<ComponentProps<typeof ConfirmDialog>, 'title' | 'description' | 'cancelText' | 'confirmText'>;
};

export function LeaveGuard({ active, question = DISCARD_CHANGES_QUESTION }: LeaveGuardProps) {
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
            {...question}
            onConfirm={() => blocker.proceed?.()}
            destructive
        />
    );
}
