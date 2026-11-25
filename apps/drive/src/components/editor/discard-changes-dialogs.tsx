// What a Drive text editor asks before unsaved edits are dropped: its own Cancel opens the discard dialog, and
// a navigation, reload or closed tab meets the leave guard. Both ask the same question, so the copy lives here.
// An editor such as the markdown editor renders it with what its save hook says about unsaved work.

import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { LeaveGuard } from '@workspace/ui/components/layout/app';

const title = 'Discard changes?';
const description = 'You have unsaved changes. Discard them?';

type DiscardChangesDialogsProps = {
    unsaved: boolean;
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
};

export function DiscardChangesDialogs({ unsaved, open, onConfirm, onCancel }: DiscardChangesDialogsProps) {
    return (
        <>
            <ConfirmDialog
                open={open}
                onOpenChange={(next) => {
                    if (!next) onCancel();
                }}
                title={title}
                description={description}
                confirmText="Discard"
                destructive
                onConfirm={onConfirm}
            />
            <LeaveGuard active={unsaved} title={title} description={description} />
        </>
    );
}
