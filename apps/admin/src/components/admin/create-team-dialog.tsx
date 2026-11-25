// The dialog that creates a team from a name. The teams page opens it from the + button in its
// toolbar. The new team joins the list, where the admin opens it to add members and drives. A
// name of only spaces is refused under the field, and the name is saved trimmed.

import { useCreateTeam } from '@workspace/lib/admin';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { useState } from 'react';

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
            <RequiredTextField label="Team name" value={name} onChange={setName} message={FIELD_MESSAGES.nameMissing} />
        </FormDialogForm>
    );
}
