// The dialog that adds a selection of users to one team. The users list opens it from the "Add to
// team…" entry of its context menu. The admin searches the organization's teams and clicks one, and
// each user joins it through the add-member mutation, one call per user.

import { useAddTeamMember, useTeams } from '@workspace/lib/admin';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { UserAvatar } from '@workspace/ui/components/user';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

type AddToTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    users: AdminUserRow[];
    organizationId?: string;
};

export function AddToTeamDialog({ open, onOpenChange, users, organizationId }: AddToTeamDialogProps) {
    const [search, setSearch] = useState('');
    const { data: teams = [] } = useTeams(organizationId);
    const addMember = useAddTeamMember();

    const filtered = useMemo(() => {
        const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
        if (!search) return sorted;
        const q = search.toLowerCase();
        return sorted.filter((t) => t.name.toLowerCase().includes(q));
    }, [teams, search]);

    const handleOpenChange = (v: boolean) => {
        onOpenChange(v);
        if (!v) setSearch('');
    };

    const handleAdd = async (teamId: string) => {
        for (const user of users) {
            await addMember.mutateAsync({ teamId, userId: user.id });
        }
        handleOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Add to team</DialogTitle>
                    <DialogDescription>
                        {users.length === 1
                            ? `Choose a team for ${users[0].name}.`
                            : `Choose a team for ${users.length} users.`}
                    </DialogDescription>
                </DialogHeader>
                <Input
                    placeholder="Search teams..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                />
                <div className="app-gutter-bleed max-h-64 overflow-y-auto">
                    {filtered.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                            {teams.length === 0 ? 'There are no teams yet.' : 'No teams match your search.'}
                        </p>
                    ) : (
                        filtered.map((team) => (
                            <button
                                key={team.id}
                                type="button"
                                disabled={addMember.isPending}
                                className="flex w-full items-center gap-3 px-2 py-2 rounded-md cursor-pointer text-left hover:bg-accent disabled:opacity-50"
                                onClick={() => handleAdd(team.id)}
                            >
                                <UserAvatar userId={teamOwnerId(team.id)} name={team.name} size="sm" />
                                <span className="flex-1 min-w-0 truncate text-sm font-medium">{team.name}</span>
                                <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                            </button>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
