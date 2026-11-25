// A dialog around a form, such as Docs' Page setup or Add link. FormDialog draws the shell with its title and
// description, and FormDialogForm the fields and the Cancel and submit footer on FormShell's keys. It opens on the
// first text field, every way to close waits for a running submit, and a failure or a false result keeps it open. The
// caller keeps the field state in a child that mounts with the dialog, so every opening starts clean. FormDialog alone
// is also a titled shell with no form, as Word count uses it.

import type { ComponentProps, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { DialogAction } from '../hooks/use-dialog-pending';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { FormShell } from './form-shell';

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
    canSubmit?: boolean;
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

    // A closing dialog stays mounted while it animates out, with the focus still in its field.
    const submit = (onSubmit: DialogAction) => (open ? run(onSubmit) : undefined);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                size={size}
                onOpenAutoFocus={onOpenAutoFocus ?? focusFirstField}
                onCloseAutoFocus={onCloseAutoFocus}
            >
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
        <FormShell
            className="flex flex-col gap-4"
            onSubmit={() => (canSubmit && !readOnly ? submit(onSubmit) : undefined)}
        >
            {children}
            {readOnly ? (
                <DialogFooter showCloseButton />
            ) : (
                <DialogFooter
                    start={
                        footerStart && (
                            <fieldset disabled={pending} className="flex gap-2">
                                {footerStart}
                            </fieldset>
                        )
                    }
                >
                    <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!canSubmit} pending={pending}>
                        {submitLabel}
                    </Button>
                </DialogFooter>
            )}
        </FormShell>
    );
}

// The first text field, else the first control, such as the calendar's recurring choice, never a colour swatch before
// the name. A lone text field with a value, such as a number to restart a list at, gets its text selected.
function focusFirstField(event: Event) {
    const form = event.target instanceof Element ? event.target.querySelector('form') : null;
    if (!form) return;
    const textFields = [...form.querySelectorAll<HTMLElement>(TEXT_FIELD)];
    const target = textFields[0] ?? form.querySelector<HTMLElement>(CONTROL);
    if (!target) return;
    event.preventDefault();
    target.focus();
    if (textFields.length === 1 && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        target.select();
    }
}

const TEXT_FIELD = [
    'input:not([type])',
    ...['text', 'search', 'url', 'tel', 'email', 'password', 'number'].map((type) => `input[type="${type}"]`),
    'textarea',
    '[contenteditable="true"]',
]
    .map((field) => `${field}:not(:disabled):not([readonly])`)
    .join(', ');

// Tabbable only: Radix's hidden radio inputs are not, and its radio group hands the focus to the checked item.
const CONTROL = ':is(input, select, textarea, button, [tabindex]):not(:disabled):not([tabindex="-1"])';
