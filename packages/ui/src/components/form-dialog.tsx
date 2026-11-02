// A dialog around a small form, such as Docs' Page setup or Add link: FormDialog draws the shell, its title and its
// description, and FormDialogForm the fields and the Cancel and submit footer. Enter in a field submits. While a submit
// runs, the buttons and every way to close wait, and the dialog closes once it succeeds. A failure keeps it open beside
// the error toast, and so does a submit that returns false, such as a check that names a field. The caller keeps the
// field state in a child that mounts with the dialog, so every opening starts clean.

import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext, useRef } from 'react';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

type FormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    size?: ComponentProps<typeof DialogContent>['size'];
    onCloseAutoFocus?: (event: Event) => void;
    children: ReactNode;
};

type FormDialogFormProps = {
    // Returns or resolves false to stay open without an error, such as a react-hook-form check that failed.
    onSubmit: () => unknown;
    canSubmit?: boolean;
    submitLabel: string;
    // A button on the left of the footer, such as Delete. It comes first in the form, so it needs type="button", or
    // Enter in a field would click it instead of submitting.
    footerStart?: ReactNode;
    // A Close button alone, for someone who may only look.
    readOnly?: boolean;
    children: ReactNode;
};

type FormDialogContext = {
    pending: boolean;
    submit: (onSubmit: () => unknown) => void;
    handleOpenChange: (open: boolean) => void;
};

// The shell owns the dialog's close and the form starts the submit, so both share one pending state.
const FormDialogPending = createContext<FormDialogContext | null>(null);

export function FormDialog({
    open,
    onOpenChange,
    title,
    description,
    size,
    onCloseAutoFocus,
    children,
}: FormDialogProps) {
    // A submit that returned false sets this, and the close that follows its success skips once.
    const keepOpen = useRef(false);
    const { pending, run, handleOpenChange } = useDialogPending((next) => {
        if (!next && keepOpen.current) keepOpen.current = false;
        else onOpenChange(next);
    });

    const submit = (onSubmit: () => unknown) => {
        // A closing dialog stays mounted while it animates out, with the focus still in its field.
        if (!open) return;
        run(async () => {
            keepOpen.current = (await onSubmit()) === false;
        });
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size={size} onCloseAutoFocus={onCloseAutoFocus}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {description && <DialogDescription>{description}</DialogDescription>}
                </DialogHeader>
                <FormDialogPending.Provider value={{ pending, submit, handleOpenChange }}>
                    {children}
                </FormDialogPending.Provider>
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
    const context = useContext(FormDialogPending);
    if (!context) throw new Error('FormDialogForm renders inside a FormDialog');
    const { pending, submit, handleOpenChange } = context;

    return (
        <form
            className="flex flex-col gap-4"
            // canSubmit is the check. The browser's own, such as a number field's step, would refuse 0.001 cm.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit && !readOnly) submit(onSubmit);
            }}
        >
            {children}
            {readOnly ? (
                <DialogFooter showCloseButton />
            ) : (
                <DialogFooter>
                    {footerStart && <div className="mr-auto flex gap-2">{footerStart}</div>}
                    <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
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
