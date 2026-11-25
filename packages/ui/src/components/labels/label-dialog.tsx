// The dialog that adds or edits a label: its name and color, and deleting it after a confirmation. A name of only
// spaces is refused under the field, and the name is saved trimmed. Contacts opens it from its label list.

import { EIGEN_ACCENT_COLORS_SHUFFLED, LABEL_NAME_MAX_LENGTH } from '@workspace/lib/constants';
import type { Label } from '@workspace/lib/types/label';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@workspace/ui/components/input-group';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { ColorPickerSwatch } from '@workspace/ui/components/media';
import { Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

type LabelDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedLabel: Label | null;
    // Rejects when the save fails, which keeps the dialog open.
    onSubmit: (data: Omit<Label, 'id'>) => Promise<unknown>;
    onDelete: () => void | Promise<void>;
    labelCount?: number;
};

export function LabelDialog({
    open,
    onOpenChange,
    selectedLabel,
    onSubmit,
    onDelete,
    labelCount = 0,
}: LabelDialogProps) {
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

    return (
        <>
            <FormDialog open={open} onOpenChange={onOpenChange} title={selectedLabel ? 'Edit label' : 'Add label'}>
                <LabelForm
                    selectedLabel={selectedLabel}
                    labelCount={labelCount}
                    onSubmit={onSubmit}
                    onDelete={() => setShowDeleteConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a cancelled delete leaves its edits in place. */}
            <ConfirmDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Delete label"
                description={
                    <>
                        Are you sure you want to delete the label <strong>{selectedLabel?.name}</strong>?
                    </>
                }
                onConfirm={onDelete}
                confirmText="Delete"
                destructive
            />
        </>
    );
}

// Mounted with the dialog, so each opening starts from the label as it is, or empty for a new one.
function LabelForm({
    selectedLabel,
    labelCount,
    onSubmit,
    onDelete,
}: {
    selectedLabel: Label | null;
    labelCount: number;
    onSubmit: (data: Omit<Label, 'id'>) => Promise<unknown>;
    onDelete: () => void;
}) {
    // As the dialog opened, so a peer's edit of the label meanwhile isn't a change of this form.
    const [initial] = useState(() => ({
        name: selectedLabel?.name ?? '',
        color:
            selectedLabel?.color ??
            EIGEN_ACCENT_COLORS_SHUFFLED[labelCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
    }));
    const [name, setName] = useState(initial.name);
    const [color, setColor] = useState(initial.color);

    return (
        <FormDialogForm
            changed={name !== initial.name || color !== initial.color}
            submitLabel={selectedLabel ? 'Save' : 'Create'}
            onSubmit={async () => {
                if (!name.trim()) return false;
                await onSubmit({ name: name.trim(), color });
            }}
            footerStart={selectedLabel && <TooltipButton icon={Trash2} tooltipText="Delete label" onClick={onDelete} />}
        >
            <LabelNameField name={name} onNameChange={setName} color={color} onColorChange={setColor} />
        </FormDialogForm>
    );
}

// Its own component, so it reads whether its form's Save was pressed.
function LabelNameField({
    name,
    onNameChange,
    color,
    onColorChange,
}: {
    name: string;
    onNameChange: (name: string) => void;
    color: string;
    onColorChange: (color: string) => void;
}) {
    const id = useId();
    const errorId = useId();
    const missing = useFormSubmitted() && !name.trim();
    return (
        <Field>
            <FieldLabel htmlFor={id}>Label name</FieldLabel>
            <InputGroup>
                <InputGroupAddon>
                    <ColorPickerSwatch value={color} onChange={onColorChange} className="size-6 rounded-sm" />
                </InputGroupAddon>
                <InputGroupInput
                    id={id}
                    placeholder="Enter label name"
                    maxLength={LABEL_NAME_MAX_LENGTH}
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    aria-invalid={missing || undefined}
                    aria-describedby={missing ? errorId : undefined}
                />
            </InputGroup>
            {missing && <FieldError id={errorId}>Add a name</FieldError>}
        </Field>
    );
}
