// The dialog that adds one or more users to a team, such as the selection the users list's "Add to
// team…" menu entry passes, or the one user whose detail shows it. The admin searches the
// organization's teams and clicks one, and every user joins it through useAddTeamMembers. A team
// every user is already in is left out, and so is the default team, which every user joins.

import { useAddTeamMembers, useTeams } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { Button } from '@workspace/ui/components/button';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { UserAvatar } from '@workspace/ui/components/user';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

type AddToTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    users: readonly AdminUserRow[];
};

export function AddToTeamDialog({ open, onOpenChange, users }: AddToTeamDialogProps) {
    const { data: config } = usePublicConfig();

    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Add to team"
            description={
                users.length === 1 ? `Choose a team for ${users[0].name}.` : `Choose a team for ${users.length} users.`
            }
        >
            {/* The content mounts only while the dialog is open, so the teams load when it opens. */}
            {config && (
                <TeamPicker
                    users={users}
                    organizationId={config.orgId}
                    defaultTeamId={config.defaultTeamId}
                    onAdded={() => onOpenChange(false)}
                />
            )}
        </FormDialog>
    );
}

type TeamPickerProps = {
    users: readonly AdminUserRow[];
    organizationId: string;
    defaultTeamId: string | undefined;
    onAdded: () => void;
};

function TeamPicker({ users, organizationId, defaultTeamId, onAdded }: TeamPickerProps) {
    const [search, setSearch] = useState('');
    const { data: orgTeams = [] } = useTeams(organizationId);
    const addMembers = useAddTeamMembers();

    const teams = useMemo(() => orgTeams.filter((team) => team.id !== defaultTeamId), [orgTeams, defaultTeamId]);
    const available = useMemo(
        () =>
            teams
                .filter((team) => !users.every((u) => u.teams.some((t) => t.id === team.id)))
                .sort((a, b) => a.name.localeCompare(b.name)),
        [teams, users],
    );
    const filtered = useMemo(() => {
        if (!search) return available;
        const q = search.toLowerCase();
        return available.filter((t) => t.name.toLowerCase().includes(q));
    }, [available, search]);

    // A user already in the team is left out, since better-auth refuses a second add. The dialog closes
    // when every add has settled; a refused one has its toast.
    const handleAdd = (teamId: string) => {
        const userIds = users.filter((u) => !u.teams.some((t) => t.id === teamId)).map((u) => u.id);
        addMembers.mutate({ teamId, userIds }, { onSettled: onAdded });
    };

    return (
        <>
            <Input
                aria-label="Search teams"
                placeholder="Search teams..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
            />
            <div className="app-gutter-bleed max-h-64 overflow-y-auto">
                {filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                        {teams.length === 0
                            ? 'There are no teams yet.'
                            : available.length === 0
                              ? 'Already in every team.'
                              : 'No teams match your search.'}
                    </p>
                ) : (
                    filtered.map((team) => {
                        const adding = addMembers.isPending && addMembers.variables?.teamId === team.id;
                        return (
                            <Button
                                key={team.id}
                                variant="ghost"
                                pending={adding}
                                disabled={addMembers.isPending && !adding}
                                className="h-auto w-full justify-start gap-3 px-2 py-2 text-left"
                                onClick={() => handleAdd(team.id)}
                            >
                                <UserAvatar userId={teamOwnerId(team.id)} name={team.name} size="sm" />
                                <span className="flex-1 min-w-0 truncate">{team.name}</span>
                                {!adding && <Plus className="text-muted-foreground" />}
                            </Button>
                        );
                    })
                )}
            </div>
        </>
    );
}
