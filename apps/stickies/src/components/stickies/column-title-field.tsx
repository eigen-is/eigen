// The Title field of the column dialogs, such as Add column and Column settings. A column can't do without a title, so
// once Save was pressed an empty one says so under the field, and the dialog's check refuses it.

import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { useId } from 'react';

export function ColumnTitleField({
    value,
    onChange,
    placeholder,
}: {
    value: string;
    onChange: (title: string) => void;
    placeholder?: string;
}) {
    const id = useId();
    const errorId = useId();
    const missing = useFormSubmitted() && !value.trim();
    return (
        <Field data-invalid={missing || undefined}>
            <FieldLabel htmlFor={id}>Title</FieldLabel>
            <Input
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                aria-invalid={missing || undefined}
                aria-describedby={missing ? errorId : undefined}
            />
            {missing && <FieldError id={errorId}>Add a title</FieldError>}
        </Field>
    );
}
