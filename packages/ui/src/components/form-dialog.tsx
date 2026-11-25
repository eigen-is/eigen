// A dialog around a form, such as Docs' Page setup or Add link. FormDialog draws the shell with its title and
// description, and FormDialogForm the fields and the Cancel and submit footer, which the card form shares, on
// FormShell's keys. It opens on the first text field, every close waits for a running submit, and a failure or a false
// result keeps it open. Esc, the X and a click outside ask "Discard changes?" once the form changed; Cancel drops it.
// The caller keeps the field state in a child that mounts with the dialog, so every opening starts clean. FormDialog
// alone is also a titled shell with no form, as Word count uses it.

import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import type { DialogAction } from '../hooks/use-dialog-pending';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { useDiscardChanges } from '../hooks/use-discard-changes';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { FormShell, focusFirstField } from './form-shell';

type FormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    // Wide unless the form is small and has nothing to type in, such as the calendar's recurring choice.
    size?: ComponentProps<typeof DialogContent>['size'];
    // Replaces the focus on the first field, such as Rename's selection of the name without its extension.
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
    children: ReactNode;
};

type FormDialogFormProps = {
    // Returns or resolves false to stay open, such as a check that marked a field invalid, which then gets the focus.
    onSubmit: DialogAction;
    // Whether the fields differ from what the dialog opened with, such as react-hook-form's isDirty. Esc, the X and a
    // click outside then ask before they drop it. One form per dialog at a time: the last one mounted wins.
    changed: boolean;
    submitLabel: string;
    // Tools on the left of the footer, such as a trash icon or Share with team, which wait while a submit runs. A raw
    // <button> there needs type="button": it comes before the submit button, so Enter in a field would click it.
    footerStart?: ReactNode;
    // A Close button alone, for someone who may only look.
    readOnly?: boolean;
    children: ReactNode;
};

type FormDialogContextValue = {
    pending: boolean;
    submit: (onSubmit: DialogAction) => Promise<false | undefined> | undefined;
    handleOpenChange: (open: boolean) => void;
    setChanged: (changed: boolean) => void;
};

// The shell owns the dialog's close and the form starts the submit and knows what changed, so both share this.
const FormDialogContext = createContext<FormDialogContextValue | null>(null);

export function FormDialog({
    open,
    onOpenChange,
    title,
    description,
    size,
    onOpenAutoFocus,
    onCloseAutoFocus,
    children,
}: FormDialogProps) {
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange);
    const [changed, setChanged] = useState(false);
    const discard = useDiscardChanges({ open, changed, pending, onDiscard: () => onOpenChange(false) });

    // A closing dialog stays mounted while it animates out, with the focus still in its field.
    const submit = (onSubmit: DialogAction) => (open ? run(onSubmit) : undefined);

    return (
        <>
            <Dialog open={open} onOpenChange={discard.onOpenChange}>
                <DialogContent
                    size={size}
                    onOpenAutoFocus={onOpenAutoFocus ?? focusOnOpen}
                    onCloseAutoFocus={onCloseAutoFocus}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>
                    <FormDialogContext.Provider value={{ pending, submit, handleOpenChange, setChanged }}>
                        {children}
                    </FormDialogContext.Provider>
                </DialogContent>
            </Dialog>
            {discard.dialog}
        </>
    );
}

export function FormDialogForm({
    onSubmit,
    changed,
    submitLabel,
    footerStart,
    readOnly = false,
    children,
}: FormDialogFormProps) {
    const context = useContext(FormDialogContext);
    if (!context) throw new Error('FormDialogForm renders inside a FormDialog');
    const { pending, submit, handleOpenChange, setChanged } = context;

    // A form that goes, such as one a loading state replaces, leaves nothing to ask about.
    const asks = changed && !readOnly;
    useEffect(() => {
        setChanged(asks);
        return () => setChanged(false);
    }, [asks, setChanged]);

    return (
        <FormShell className="flex flex-col gap-4" onSubmit={() => (readOnly ? undefined : submit(onSubmit))}>
            {children}
            {readOnly ? (
                <DialogFooter showCloseButton />
            ) : (
                <FormFooter
                    start={footerStart}
                    pending={pending}
                    onCancel={() => handleOpenChange(false)}
                    submitLabel={submitLabel}
                />
            )}
        </FormShell>
    );
}

// The Cancel and submit footer of a form shell, such as a dialog's or a card's, with its tools on the left. Every
// button waits while the submit runs.
export function FormFooter({
    start,
    pending,
    onCancel,
    canSubmit = true,
    submitLabel,
}: {
    start?: ReactNode;
    pending: boolean;
    onCancel: () => void;
    // Off only in a picker until something is picked: it has no field to show a message under.
    canSubmit?: boolean;
    submitLabel: string;
}) {
    return (
        <DialogFooter
            start={
                start && (
                    <fieldset disabled={pending} className="flex gap-2">
                        {start}
                    </fieldset>
                )
            }
        >
            <Button variant="outline" onClick={onCancel} disabled={pending}>
                Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} pending={pending}>
                {submitLabel}
            </Button>
        </DialogFooter>
    );
}

// Radix focuses the dialog itself unless the form took the focus.
function focusOnOpen(event: Event) {
    const form = event.target instanceof Element ? event.target.querySelector('form') : null;
    if (form && focusFirstField(form, { selectLone: true })) event.preventDefault();
}
