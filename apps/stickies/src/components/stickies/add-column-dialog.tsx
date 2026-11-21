// The dialog that adds a column to a board. It asks for the column's title and hands it to the board, which
// writes the column into the board's document.

import { Field, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type AddColumnDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAddColumn: (title: string) => void;
};

export function AddColumnDialog({ open, onOpenChange, onAddColumn }: AddColumnDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Add column">
            <AddColumnForm onAddColumn={onAddColumn} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts with an empty title.
function AddColumnForm({ onAddColumn }: Pick<AddColumnDialogProps, 'onAddColumn'>) {
    const [title, setTitle] = useState('');

    return (
        <FormDialogForm
            canSubmit={title.trim() !== ''}
            submitLabel="Add column"
            onSubmit={() => onAddColumn(title.trim())}
        >
            <Field>
                <FieldLabel htmlFor="column-title">Title</FieldLabel>
                <Input
                    id="column-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter column title"
                    autoFocus
                />
            </Field>
        </FormDialogForm>
    );
}
