// The dialog that creates a team from a name. The teams page opens it from the + button in its
// toolbar. The new team joins the list, where the admin opens it to add members and drives.

import { useCreateTeam } from '@workspace/lib/admin';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type CreateTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organizationId?: string;
};

export function CreateTeamDialog({ open, onOpenChange, organizationId }: CreateTeamDialogProps) {
    const [name, setName] = useState('');
    const createTeam = useCreateTeam(organizationId);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        await createTeam.mutateAsync(name.trim());
        setName('');
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create team</DialogTitle>
                    <DialogDescription className="sr-only">Name the new team.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <Input
                        placeholder="Team name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                        required
                    />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={createTeam.isPending}>
                            {createTeam.isPending ? 'Creating...' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
