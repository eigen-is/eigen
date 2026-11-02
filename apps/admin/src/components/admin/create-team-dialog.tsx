// The dialog that creates a team from a name. The teams page opens it from the + button in its
// toolbar. The new team joins the list, where the admin opens it to add members and drives.

import { useCreateTeam } from '@workspace/lib/admin';
import { FormDialog, FormDialogForm } from '@workspace/ui';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type CreateTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organizationId?: string;
};

export function CreateTeamDialog({ open, onOpenChange, organizationId }: CreateTeamDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Create team">
            <CreateTeamForm organizationId={organizationId} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts with an empty name.
function CreateTeamForm({ organizationId }: { organizationId?: string }) {
    const [name, setName] = useState('');
    const createTeam = useCreateTeam(organizationId);
    const trimmed = name.trim();

    return (
        <FormDialogForm
            canSubmit={trimmed !== ''}
            submitLabel="Create"
            onSubmit={() => createTeam.mutateAsync(trimmed)}
        >
            <Input placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </FormDialogForm>
    );
}
