// The dialog that adds or edits a label: its name and color, and deleting it after a confirmation. Save waits for a
// name that is more than spaces, and the name is saved trimmed. Contacts opens it from its label list.

import { EIGEN_ACCENT_COLORS_SHUFFLED, LABEL_NAME_MAX_LENGTH } from '@workspace/lib/constants';
import type { Label } from '@workspace/lib/types/label';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@workspace/ui/components/input-group';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { ColorPickerSwatch } from '@workspace/ui/components/media/color-picker-swatch';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

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
    const [name, setName] = useState(selectedLabel?.name ?? '');
    const [color, setColor] = useState(
        selectedLabel?.color ?? EIGEN_ACCENT_COLORS_SHUFFLED[labelCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
    );

    return (
        <FormDialogForm
            canSubmit={name.trim() !== ''}
            submitLabel="Save"
            onSubmit={async () => {
                await onSubmit({ name: name.trim(), color });
            }}
            footerStart={selectedLabel && <TooltipButton icon={Trash2} tooltipText="Delete label" onClick={onDelete} />}
        >
            <Field>
                <FieldLabel htmlFor="label-name">Label name</FieldLabel>
                <InputGroup>
                    <InputGroupAddon>
                        <ColorPickerSwatch value={color} onChange={setColor} className="size-6 rounded-sm" />
                    </InputGroupAddon>
                    <InputGroupInput
                        id="label-name"
                        placeholder="Enter label name"
                        autoFocus
                        maxLength={LABEL_NAME_MAX_LENGTH}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </InputGroup>
            </Field>
        </FormDialogForm>
    );
}
