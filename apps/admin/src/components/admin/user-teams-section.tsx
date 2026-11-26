// The Teams section of a user's detail in the Admin app: the teams the user is in, each with a remove button that asks
// first, and an Add to team button that opens the team picker. It is the user-side twin of a team's Members section and
// changes membership through the same mutations. The organization's default team, which every user joins, has no
// remove button.

import { usePublicConfig } from '@workspace/lib/public';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { Button } from '@workspace/ui/components/button';
import { DetailSection, EmptyState } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserAvatar } from '@workspace/ui/components/user';
import { Plus, UsersRound, X } from 'lucide-react';
import { useState } from 'react';
import { AddToTeamDialog } from './add-to-team-dialog';
import { RemoveFromTeamDialog } from './remove-from-team-dialog';

export function UserTeamsSection({ user }: { user: AdminUserRow }) {
    const [showAddDialog, setShowAddDialog] = useState(false);
    // Kept after the question closes, so it still names the team while it fades out.
    const [removing, setRemoving] = useState({ id: '', name: '' });
    const [confirmOpen, setConfirmOpen] = useState(false);
    const { data: config } = usePublicConfig();
    const teams = [...user.teams].sort((a, b) => a.name.localeCompare(b.name));

    return (
        <DetailSection
            label={`Teams (${teams.length})`}
            action={
                <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Add to team
                </Button>
            }
        >
            <AddToTeamDialog open={showAddDialog} onOpenChange={setShowAddDialog} users={[user]} />

            {teams.length === 0 ? (
                <EmptyState icon={<UsersRound className="h-6 w-6" />} message="Not in any team yet" />
            ) : (
                <div className="divide-y">
                    {teams.map((team) => (
                        <div key={team.id} className="flex items-center gap-3 py-2">
                            <UserAvatar userId={teamOwnerId(team.id)} name={team.name} size="sm" />
                            <span className="flex-1 min-w-0 truncate text-sm font-medium">{team.name}</span>
                            {team.id !== config?.defaultTeamId && (
                                <TooltipButton
                                    icon={X}
                                    tooltipText={`Remove from ${team.name}`}
                                    className="h-7 w-7 shrink-0"
                                    onClick={() => {
                                        setRemoving(team);
                                        setConfirmOpen(true);
                                    }}
                                />
                            )}
                        </div>
                    ))}
                </div>
            )}

            <RemoveFromTeamDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                team={removing}
                member={{ userId: user.id, name: user.name }}
            />
        </DetailSection>
    );
}
