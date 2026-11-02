// A dialog around a small form, such as Docs' Page setup or Add link: FormDialog draws the shell and its title, and
// FormDialogForm the fields and the Cancel and submit footer. Enter in a field submits. While a submit runs, the buttons
// and every way to close wait, and the dialog closes once it succeeds. A failure keeps it open beside the error toast.
// The caller keeps the field state in a child that mounts with the dialog, so every opening starts clean.

import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

type FormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    // What a screen reader reads after the title.
    description?: string;
    size?: ComponentProps<typeof DialogContent>['size'];
    onCloseAutoFocus?: (event: Event) => void;
    children: ReactNode;
};

type FormDialogFormProps = {
    onSubmit: () => void | Promise<void>;
    canSubmit?: boolean;
    submitLabel: string;
    cancelLabel?: string;
    // A button on the left of the footer, such as Delete.
    footerStart?: ReactNode;
    // A Close button alone, for someone who may only look.
    readOnly?: boolean;
    children: ReactNode;
};

// The shell owns the dialog's close and the form runs the submit, so both share one pending state.
const FormDialogPending = createContext<ReturnType<typeof useDialogPending> | null>(null);

export function FormDialog({
    open,
    onOpenChange,
    title,
    description,
    size,
    onCloseAutoFocus,
    children,
}: FormDialogProps) {
    const pending = useDialogPending(onOpenChange);

    return (
        <Dialog open={open} onOpenChange={pending.handleOpenChange}>
            <DialogContent size={size} onCloseAutoFocus={onCloseAutoFocus}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {description && <DialogDescription className="sr-only">{description}</DialogDescription>}
                </DialogHeader>
                <FormDialogPending.Provider value={pending}>{children}</FormDialogPending.Provider>
            </DialogContent>
        </Dialog>
    );
}

export function FormDialogForm({
    onSubmit,
    canSubmit = true,
    submitLabel,
    cancelLabel = 'Cancel',
    footerStart,
    readOnly = false,
    children,
}: FormDialogFormProps) {
    const context = useContext(FormDialogPending);
    if (!context) throw new Error('FormDialogForm renders inside a FormDialog');
    const { pending, run, handleOpenChange } = context;

    return (
        <form
            className="flex flex-col gap-4"
            // canSubmit is the check. The browser's own, such as a number field's step, would refuse 0.001 cm.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit && !readOnly) run(onSubmit);
            }}
        >
            {children}
            {readOnly ? (
                <DialogFooter showCloseButton />
            ) : (
                <DialogFooter>
                    {footerStart && <div className="mr-auto flex gap-2">{footerStart}</div>}
                    <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
                        {cancelLabel}
                    </Button>
                    <Button type="submit" disabled={!canSubmit || pending}>
                        {submitLabel}
                    </Button>
                </DialogFooter>
            )}
        </form>
    );
}
