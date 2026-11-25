// The <form> under every form shell, such as FormDialogForm, so a dialog, a card and a page share their keys, their
// first focus and their error focus. Cmd or Ctrl+Enter submits from any field, with what the field committed on that
// key, and Enter on a radio or a checkbox submits too, since Radix swallows it there. Once Save was pressed, and until a
// submit goes through, its fields read useFormSubmitted(), so a missing value shows only then, and a refused submit
// focuses the first field marked aria-invalid while the form still shows. Apps use the shells, not this.

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { DialogAction } from '../hooks/use-dialog-pending';

type FormShellProps = {
    // Returns or resolves false when its check refused, so the shell focuses the field that says why.
    onSubmit: DialogAction;
    // A react-hook-form form focuses its first error itself.
    focusesOwnErrors?: boolean;
    // Focuses the first field as the form mounts, as a page form does. A dialog focuses its form as it opens instead.
    autoFocus?: boolean;
    className?: string;
    children: ReactNode;
};

const CHOICE = '[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]';
const HIDDEN = '[hidden], [aria-hidden="true"], [role="dialog"][data-state="closed"]';

const FormSubmittedContext = createContext(false);

export function useFormSubmitted(): boolean {
    return useContext(FormSubmittedContext);
}

export function FormShell({
    onSubmit,
    focusesOwnErrors = false,
    autoFocus = false,
    className,
    children,
}: FormShellProps) {
    const formRef = useRef<HTMLFormElement>(null);
    const [submitted, setSubmitted] = useState(false);
    // Counts refused submits, so the focus moves once the form has rendered the messages it set.
    const [refusals, setRefusals] = useState(0);

    useEffect(() => {
        if (autoFocus && formRef.current) focusFirstField(formRef.current);
    }, [autoFocus]);

    // A form that refused as it hid itself, such as Edit event opening a question over it, leaves the focus to that.
    useEffect(() => {
        const form = formRef.current;
        if (refusals === 0 || !form?.isConnected || form.closest(HIDDEN)) return;
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }, [refusals]);

    const submit = async () => {
        setSubmitted(true);
        const refused = (await onSubmit()) === false;
        // A form that stays after its save, such as a page form, starts clean, so a later edit isn't red before Save.
        setSubmitted(refused);
        if (refused && !focusesOwnErrors) setRefusals((count) => count + 1);
    };

    return (
        <form
            ref={formRef}
            className={className}
            // The shells show a field's problem under it. The browser's own check, such as a number field's step,
            // would refuse 0.001 cm with a bubble.
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                // React passes a portaled submit up to a form that holds the dialog, and that form must not submit too.
                event.stopPropagation();
                submit();
            }}
            onKeyDown={(event) => {
                const { target, currentTarget: form } = event;
                // A key from a portal, such as a picker's popover, reaches this form through React alone.
                if (event.key !== 'Enter' || !(target instanceof Element) || !form.contains(target)) return;
                const modified = event.metaKey || event.ctrlKey;
                if (!modified && !target.matches(CHOICE)) return;
                // A field that took Cmd+Enter for itself, such as a rich-text field's line break, did so for the form.
                event.preventDefault();
                // Or a hotkey behind the form, such as Mail's send, would act on the same key.
                if (modified) event.stopPropagation();
                // A field that commits on this Enter, such as a time field, sets its value in this event. React has
                // rendered it by the next task, so the submit waits for that and reads what the field committed.
                setTimeout(() => {
                    if (form.isConnected) form.requestSubmit();
                });
            }}
        >
            <FormSubmittedContext.Provider value={submitted}>{children}</FormSubmittedContext.Provider>
        </form>
    );
}

// The first text field, else the first control, such as the calendar's recurring choice, never a color swatch before
// the name. With `selectLone`, a lone text field with a value, such as a number to restart a list at, gets its text
// selected. False when the form has nothing to focus.
export function focusFirstField(form: HTMLFormElement, { selectLone = false } = {}): boolean {
    const textFields = [...form.querySelectorAll<HTMLElement>(TEXT_FIELD)];
    const target = textFields[0] ?? form.querySelector<HTMLElement>(CONTROL);
    if (!target) return false;
    target.focus();
    if (
        selectLone &&
        textFields.length === 1 &&
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    ) {
        target.select();
    }
    return true;
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
