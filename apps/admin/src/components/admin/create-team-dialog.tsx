// The dialog that creates a team from a name. The teams page opens it from the + button in its
// toolbar. The new team joins the list, where the admin opens it to add members and drives. A
// name of only spaces is refused under the field, and the name is saved trimmed.

import { useCreateTeam } from '@workspace/lib/admin';
import { Field, FieldContent, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { useId, useState } from 'react';

type CreateTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organizationId: string;
};

export function CreateTeamDialog({ open, onOpenChange, organizationId }: CreateTeamDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Create team">
            <CreateTeamForm organizationId={organizationId} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts with an empty name.
function CreateTeamForm({ organizationId }: { organizationId: string }) {
    const [name, setName] = useState('');
    const createTeam = useCreateTeam(organizationId);

    return (
        <FormDialogForm
            changed={name !== ''}
            submitLabel="Create"
            onSubmit={async () => {
                if (!name.trim()) return false;
                await createTeam.mutateAsync(name.trim());
            }}
        >
            <TeamNameField name={name} onNameChange={setName} />
        </FormDialogForm>
    );
}

// Its own component, so it reads whether its form's Create was pressed.
function TeamNameField({ name, onNameChange }: { name: string; onNameChange: (name: string) => void }) {
    const id = useId();
    const errorId = useId();
    const missing = useFormSubmitted() && !name.trim();
    return (
        <Field>
            <FieldLabel htmlFor={id}>Team name</FieldLabel>
            <FieldContent>
                <Input
                    id={id}
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    aria-invalid={missing || undefined}
                    aria-describedby={missing ? errorId : undefined}
                />
                {missing && <FieldError id={errorId}>Add a name</FieldError>}
            </FieldContent>
        </Field>
    );
}
