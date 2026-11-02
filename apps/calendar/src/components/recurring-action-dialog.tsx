// Asks which events of a series an edit or a delete applies to: this one, this and the following ones, or all. The
// event dialogs open it before they change a recurring event, and OK hands the choice to their onConfirm.

import { FormDialog, FormDialogForm } from '@workspace/ui';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useState } from 'react';

export type RecurringAction = 'this' | 'this-and-following' | 'all';

type RecurringActionDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: (action: RecurringAction) => void | Promise<void>;
    options?: readonly RecurringAction[];
};

const ACTION_LABELS: Record<RecurringAction, string> = {
    this: 'This event',
    'this-and-following': 'This and following events',
    all: 'All events in series',
};

export function RecurringActionDialog({ open, onOpenChange, title, onConfirm, options }: RecurringActionDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title={title} size="xs">
            <RecurringActionForm onConfirm={onConfirm} options={options ?? ['this', 'this-and-following', 'all']} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts at the first option.
function RecurringActionForm({
    onConfirm,
    options,
}: {
    onConfirm: (action: RecurringAction) => void | Promise<void>;
    options: readonly RecurringAction[];
}) {
    const [selected, setSelected] = useState(options[0]);

    return (
        <FormDialogForm submitLabel="OK" onSubmit={() => onConfirm(selected)}>
            <RadioGroup
                value={selected}
                onValueChange={(value) => setSelected(options.find((option) => option === value) ?? options[0])}
                className="space-y-2"
            >
                {options.map((option) => (
                    <div key={option} className="flex items-center gap-2">
                        <RadioGroupItem value={option} id={`recurring-${option}`} />
                        <Label htmlFor={`recurring-${option}`} className="cursor-pointer">
                            {ACTION_LABELS[option]}
                        </Label>
                    </div>
                ))}
            </RadioGroup>
        </FormDialogForm>
    );
}
