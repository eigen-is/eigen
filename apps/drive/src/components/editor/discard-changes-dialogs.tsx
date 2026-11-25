// What a Drive text editor asks before unsaved edits are dropped: its own Cancel opens the discard dialog, and
// a navigation, reload or closed tab meets the leave guard. Both ask what every form asks, "Discard changes?". An
// editor such as the markdown editor renders it with what its save hook says is at risk.

import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { LeaveGuard } from '@workspace/ui/components/layout/app';
import { DISCARD_CHANGES_QUESTION } from '@workspace/ui/hooks/use-discard-changes';

type DiscardChangesDialogsProps = {
    atRisk: boolean;
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
};

export function DiscardChangesDialogs({ atRisk, open, onConfirm, onCancel }: DiscardChangesDialogsProps) {
    return (
        <>
            <ConfirmDialog
                open={open}
                onOpenChange={(next) => {
                    if (!next) onCancel();
                }}
                {...DISCARD_CHANGES_QUESTION}
                destructive
                onConfirm={onConfirm}
            />
            <LeaveGuard active={atRisk} />
        </>
    );
}
