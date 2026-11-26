// The dialog that adds a column to a board. It asks for the column's title and hands it to the board, which
// writes the column into the board's document.

import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
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

    const handleSubmit = () => {
        if (!title.trim()) return false;
        onAddColumn(title.trim());
    };

    return (
        <FormDialogForm changed={title !== ''} submitLabel="Add column" onSubmit={handleSubmit}>
            <RequiredTextField
                label="Title"
                value={title}
                onChange={setTitle}
                placeholder="Enter column title"
                message={FIELD_MESSAGES.titleMissing}
            />
        </FormDialogForm>
    );
}
