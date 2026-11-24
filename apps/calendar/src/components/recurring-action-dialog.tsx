// Asks which events of a series an edit, a delete or a drop applies to: this one, this and the following ones, or all.
// The event dialogs open it before they change a recurring event, and OK hands the choice to their onConfirm. A host
// with a next question, such as a drop's guest question, resolves false and closes it by its open flag instead.

import type { RecurrenceScope } from '@workspace/lib/types/calendar';
import { RECURRENCE_SCOPES } from '@workspace/lib/types/calendar';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import type { DialogAction } from '@workspace/ui/hooks/use-dialog-pending';
import { useState } from 'react';

const SCOPE_LABELS: Record<RecurrenceScope, string> = {
    this: 'This event',
    'this-and-following': 'This and following events',
    all: 'All events in series',
};

type RecurringActionDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: (scope: RecurrenceScope) => ReturnType<DialogAction>;
    options?: readonly RecurrenceScope[];
};

export function RecurringActionDialog({ open, onOpenChange, title, onConfirm, options }: RecurringActionDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title={title} size="sm">
            <RecurringActionForm title={title} onConfirm={onConfirm} options={options ?? RECURRENCE_SCOPES} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts at the first option.
function RecurringActionForm({
    title,
    onConfirm,
    options,
}: Required<Pick<RecurringActionDialogProps, 'title' | 'onConfirm' | 'options'>>) {
    const [selected, setSelected] = useState(options[0]);

    return (
        <FormDialogForm submitLabel="OK" onSubmit={() => onConfirm(selected)}>
            {/* Radix keeps the dialog title's id to itself, so the group repeats the title as its name. */}
            <RadioGroup
                aria-label={title}
                value={selected}
                onValueChange={(value) => setSelected(options.find((option) => option === value) ?? options[0])}
                className="space-y-2"
            >
                {options.map((option) => (
                    <div key={option} className="flex items-center gap-2">
                        <RadioGroupItem value={option} id={`recurring-${option}`} />
                        <Label htmlFor={`recurring-${option}`} className="cursor-pointer">
                            {SCOPE_LABELS[option]}
                        </Label>
                    </div>
                ))}
            </RadioGroup>
        </FormDialogForm>
    );
}
