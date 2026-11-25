// The Teams section of a user's detail in the Admin app: the teams the user belongs to, each with a
// button that takes the user out of it after a confirmation, and an "Add to team" button that opens the team picker. It
// is the user-side twin of a team's Members section, laid out the same way, and changes membership
// through the same team-member mutations. The organization's default team, which every user joins,
// is left out, so the count and the empty state are about the teams an admin chose.

import { useRemoveTeamMember } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { EmptyState } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserAvatar } from '@workspace/ui/components/user';
import { Plus, UsersRound, X } from 'lucide-react';
import { useState } from 'react';
import { AddToTeamDialog } from './add-to-team-dialog';

export function UserTeamsSection({ user }: { user: AdminUserRow }) {
    const [showAddDialog, setShowAddDialog] = useState(false);
    // Kept after the question closes, so it still names the team while it fades out.
    const [removing, setRemoving] = useState({ id: '', name: '' });
    const [confirmOpen, setConfirmOpen] = useState(false);
    const removeMember = useRemoveTeamMember();
    const { data: config } = usePublicConfig();
    const teams = user.teams
        .filter((team) => team.id !== config?.defaultTeamId)
        .sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Teams ({teams.length})</h3>
                <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Add to team
                </Button>
            </div>

            <AddToTeamDialog open={showAddDialog} onOpenChange={setShowAddDialog} users={[user]} />

            {teams.length === 0 ? (
                <EmptyState icon={<UsersRound className="h-6 w-6" />} message="Not in any team yet" />
            ) : (
                <div className="divide-y">
                    {teams.map((team) => (
                        <div key={team.id} className="flex items-center gap-3 py-2">
                            <UserAvatar userId={teamOwnerId(team.id)} name={team.name} size="sm" />
                            <span className="flex-1 min-w-0 truncate text-sm font-medium">{team.name}</span>
                            <TooltipButton
                                icon={X}
                                tooltipText={`Remove from ${team.name}`}
                                className="h-7 w-7 shrink-0"
                                onClick={() => {
                                    setRemoving(team);
                                    setConfirmOpen(true);
                                }}
                            />
                        </div>
                    ))}
                </div>
            )}

            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Remove from team"
                description={
                    <>
                        Remove <strong>{user.name}</strong> from <strong>{removing.name}</strong>? They lose access to
                        what is shared with the team.
                    </>
                }
                onConfirm={async () => {
                    await removeMember.mutateAsync({ teamId: removing.id, userId: user.id });
                }}
                confirmText="Remove"
                destructive
            />
        </div>
    );
}
