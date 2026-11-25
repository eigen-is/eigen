// The "Discard changes?" question a form shell asks before a close would drop what the user changed, such as Esc, the
// corner X or a click outside a form dialog. The shell hands Radix its onOpenChange: a close discards at once when
// nothing changed, and otherwise opens the question, whose red Discard discards and whose Keep editing goes back to the
// form, with the focus back in the field the user was in, not on the X they pressed. While a save runs a close does
// nothing, since the save decides whether the form closes. The shell renders `dialog` beside its own and spreads
// `onFocus` on its dialog's content; a button that says it discards, such as Cancel, skips the question. The question's
// words are shared, so a page's leave guard and an editor's Cancel ask the same.

import type { FocusEvent, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';
import { focusFirstField } from '../components/form-shell';

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
    onFocus: (event: FocusEvent<HTMLElement>) => void;
} {
    const [asking, setAsking] = useState(false);
    // The form dialog's content, and the last field in its form that had the focus.
    const content = useRef<HTMLElement | null>(null);
    const lastField = useRef<HTMLElement | null>(null);
    // A host that closes the dialog itself leaves nothing to ask about, and its next opening asks nothing.
    if (asking && !open) setAsking(false);

    // A dialog with no trigger inside it only ever asks Radix to close.
    const onOpenChange = (next: boolean) => {
        if (next || pending) return;
        if (changed) setAsking(true);
        else onDiscard();
    };

    // React passes up a focus from a portal too, such as a date picker's popover, which is no field of this form.
    const onFocus = ({ target, currentTarget }: FocusEvent<HTMLElement>) => {
        content.current = currentTarget;
        if (currentTarget.contains(target) && target.closest('form')) lastField.current = target;
    };

    // The press that asked focused the X, or nothing for a click outside, and Radix would give the focus back to that.
    // Keep editing leaves the form open; Discard closes it, and the dialog gives the focus back to what opened it.
    const returnToField = (event: Event) => {
        if (!open) return;
        const field = lastField.current;
        const form = content.current?.querySelector('form');
        if (field?.isConnected) field.focus();
        else if (!form || !focusFirstField(form)) return;
        event.preventDefault();
    };

    const dialog = (
        <ConfirmDialog
            {...DISCARD_CHANGES_QUESTION}
            open={asking}
            onOpenChange={setAsking}
            destructive
            onConfirm={onDiscard}
            onCloseAutoFocus={returnToField}
        />
    );

    return { onOpenChange, dialog, onFocus };
}
