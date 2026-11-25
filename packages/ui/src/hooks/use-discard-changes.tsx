// The "Discard changes?" question a form shell asks before a close would drop what the user changed, such as Esc, the
// corner X or a click outside a form dialog. requestClose discards at once when nothing changed, and otherwise opens
// the question, whose red Discard discards and whose Keep editing goes back to the form. The shell renders `dialog`
// beside its own; a button that says it discards, such as Cancel, skips the question.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';

export function useDiscardChanges({ changed, onDiscard }: { changed: boolean; onDiscard: () => void }): {
    requestClose: () => void;
    dialog: ReactNode;
} {
    const [asking, setAsking] = useState(false);

    const requestClose = () => {
        if (changed) setAsking(true);
        else onDiscard();
    };

    const dialog = (
        <ConfirmDialog
            open={asking}
            onOpenChange={setAsking}
            title="Discard changes?"
            description="What you changed is not saved."
            cancelText="Keep editing"
            confirmText="Discard"
            destructive
            onConfirm={onDiscard}
        />
    );

    return { requestClose, dialog };
}
