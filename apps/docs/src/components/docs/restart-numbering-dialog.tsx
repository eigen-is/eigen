// Google Docs' List options › Restart numbering: the number a numbered list starts at, from the item the caret is in.
// The toolbar opens it from the Format menu, and Apply restarts the numbering there.

import type { Editor } from '@tiptap/react';
import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useId, useState } from 'react';
import { restartNumbering } from './list-numbering';

type RestartNumberingDialogProps = {
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus: (event: Event) => void;
};

export function RestartNumberingDialog({ editor, open, onOpenChange, onCloseAutoFocus }: RestartNumberingDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Restart numbering"
            onCloseAutoFocus={onCloseAutoFocus}
        >
            <RestartNumberingForm editor={editor} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts at 1.
function RestartNumberingForm({ editor }: { editor: Editor }) {
    const [startAt, setStartAt] = useState('1');
    const start = Number(startAt);
    const valid = Number.isInteger(start) && start >= 1;
    const errorId = useId();

    return (
        <FormDialogForm
            submitLabel="Apply"
            changed={startAt !== '1'}
            onSubmit={() => (valid ? restartNumbering(editor, start) : false)}
        >
            <Field orientation="horizontal">
                <FieldLabel htmlFor="restart-numbering-start">Start at</FieldLabel>
                <Input
                    id="restart-numbering-start"
                    type="number"
                    min={1}
                    className="w-24"
                    aria-invalid={!valid || undefined}
                    aria-describedby={valid ? undefined : errorId}
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                />
            </Field>
            {!valid && <FieldError id={errorId}>Start at a whole number of 1 or more.</FieldError>}
        </FormDialogForm>
    );
}
