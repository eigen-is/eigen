// A dialog around a small form, such as Docs' Page setup or Add link. FormDialog draws the shell with its title and
// description, and FormDialogForm the fields and the Cancel and submit footer. Enter in a field submits, every way to
// close waits for a running submit, and a failure or a false result keeps the dialog open. The caller keeps the field
// state in a child that mounts with the dialog, so every opening starts clean. FormDialog alone is also a titled shell
// with no form, as Word count uses it.

import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { DialogAction } from '../hooks/use-dialog-pending';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

type FormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    size?: ComponentProps<typeof DialogContent>['size'];
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
    children: ReactNode;
};

type FormDialogFormProps = {
    // Returns or resolves false to stay open without an error, such as a react-hook-form check that failed.
    onSubmit: DialogAction;
    canSubmit?: boolean;
    submitLabel: string;
    // A button on the left of the footer, such as Delete, which waits while a submit runs. A raw <button> there needs
    // type="button": it comes before the submit button, so Enter in a field would click it.
    footerStart?: ReactNode;
    // A Close button alone, for someone who may only look.
    readOnly?: boolean;
    children: ReactNode;
};

type FormDialogContextValue = {
    pending: boolean;
    submit: (onSubmit: DialogAction) => void;
    handleOpenChange: (open: boolean) => void;
};

// The shell owns the dialog's close and the form starts the submit, so both share one pending state.
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

    const submit = (onSubmit: DialogAction) => {
        // A closing dialog stays mounted while it animates out, with the focus still in its field.
        if (open) run(onSubmit);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size={size} onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {description && <DialogDescription>{description}</DialogDescription>}
                </DialogHeader>
                <FormDialogContext.Provider value={{ pending, submit, handleOpenChange }}>
                    {children}
                </FormDialogContext.Provider>
            </DialogContent>
        </Dialog>
    );
}

export function FormDialogForm({
    onSubmit,
    canSubmit = true,
    submitLabel,
    footerStart,
    readOnly = false,
    children,
}: FormDialogFormProps) {
    const context = useContext(FormDialogContext);
    if (!context) throw new Error('FormDialogForm renders inside a FormDialog');
    const { pending, submit, handleOpenChange } = context;

    return (
        <form
            className="flex flex-col gap-4"
            // canSubmit is the check. The browser's own, such as a number field's step, would refuse 0.001 cm.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                // React passes a portaled submit up to a form that holds the dialog, and that form must not submit too.
                e.stopPropagation();
                if (canSubmit && !readOnly) submit(onSubmit);
            }}
        >
            {children}
            {readOnly ? (
                <DialogFooter showCloseButton />
            ) : (
                <DialogFooter>
                    {footerStart && (
                        <fieldset disabled={pending} className="mr-auto flex gap-2">
                            {footerStart}
                        </fieldset>
                    )}
                    <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!canSubmit || pending}>
                        {submitLabel}
                    </Button>
                </DialogFooter>
            )}
        </form>
    );
}
