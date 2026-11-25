// The "Discard changes?" question a form shell asks before a close would drop what the user changed, such as Esc, the
// corner X or a click outside a form dialog. The shell hands Radix its onOpenChange: a close discards at once when
// nothing changed, and otherwise opens the question, whose red Discard discards and whose Keep editing goes back to the
// form. While a save runs a close does nothing, since the save decides whether the form closes. The shell renders `dialog` beside its own; a button that says it discards, such as Cancel, skips the question.
// The question's words are shared, so a page's leave guard and an editor's Cancel ask the same.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';

export const DISCARD_CHANGES_QUESTION = {
    title: 'Discard changes?',
    description: 'What you changed is not saved.',
    cancelText: 'Keep editing',
    confirmText: 'Discard',
} as const;

export function useDiscardChanges({
    open,
    changed,
    pending,
    onDiscard,
}: {
    open: boolean;
    changed: boolean;
    pending: boolean;
    onDiscard: () => void;
}): {
    onOpenChange: (open: boolean) => void;
    dialog: ReactNode;
} {
    const [asking, setAsking] = useState(false);
    // A host that closes the dialog itself leaves nothing to ask about, and its next opening asks nothing.
    if (asking && !open) setAsking(false);

    // A dialog with no trigger inside it only ever asks Radix to close.
    const onOpenChange = (next: boolean) => {
        if (next || pending) return;
        if (changed) setAsking(true);
        else onDiscard();
    };

    const dialog = (
        <ConfirmDialog
            {...DISCARD_CHANGES_QUESTION}
            open={asking}
            onOpenChange={setAsking}
            destructive
            onConfirm={onDiscard}
        />
    );

    return { onOpenChange, dialog };
}
