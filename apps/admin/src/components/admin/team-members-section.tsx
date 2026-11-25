// The Members section of a team's detail in the Admin app: the team's members, each with a button that
// takes them out after a confirmation, and an Add button that picks one of the organization's members to
// join. The organization's default team, which every user joins, has no remove buttons. A user's detail
// has the same section the other way round, the teams that user is in.

import { useMembers, useRemoveTeamMember } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { useTeamMembers } from '@workspace/lib/team';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { EmptyState } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserItem } from '@workspace/ui/components/user';
import { UserRoundPlus, X } from 'lucide-react';
import { useState } from 'react';
import { AddMemberDialog } from './add-member-dialog';

type TeamMembersSectionProps = {
    team: OrgTeam;
    organizationId: string;
};

export function TeamMembersSection({ team, organizationId }: TeamMembersSectionProps) {
    const [showAddDialog, setShowAddDialog] = useState(false);
    // Kept after the question closes, so it still names the member while it fades out.
    const [removing, setRemoving] = useState({ userId: '', name: '' });
    const [confirmOpen, setConfirmOpen] = useState(false);

    const { data: teamMembers = [] } = useTeamMembers(team.id);
    const { data: allMembers = [] } = useMembers(organizationId);
    const removeMember = useRemoveTeamMember();
    const { data: config } = usePublicConfig();
    const isDefaultTeam = team.id === config?.defaultTeamId;

    const teamMemberUserIds = new Set(teamMembers.map((m) => m.userId));
    const availableMembers = allMembers.filter((m) => !teamMemberUserIds.has(m.userId));

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Members ({teamMembers.length})</h3>
                <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
                    <UserRoundPlus className="h-4 w-4 mr-1" />
                    Add
                </Button>
            </div>

            <AddMemberDialog
                open={showAddDialog}
                onOpenChange={setShowAddDialog}
                teamId={team.id}
                availableMembers={availableMembers}
            />

            {teamMembers.length === 0 ? (
                <EmptyState icon={<UserRoundPlus className="h-6 w-6" />} message="No members in this team yet" />
            ) : (
                <div className="divide-y">
                    {[...teamMembers]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((member) => (
                            <div key={member.userId} className="flex items-center gap-3 py-2">
                                <UserItem
                                    name={member.name}
                                    email={member.email}
                                    userId={member.userId}
                                    className="flex-1 min-w-0"
                                />
                                {!isDefaultTeam && (
                                    <TooltipButton
                                        icon={X}
                                        tooltipText={`Remove ${member.name || member.email} from team`}
                                        className="h-7 w-7 shrink-0"
                                        onClick={() => {
                                            setRemoving({ userId: member.userId, name: member.name || member.email });
                                            setConfirmOpen(true);
                                        }}
                                    />
                                )}
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
                        Remove <strong>{removing.name}</strong> from <strong>{team.name}</strong>? They lose access to
                        what is shared with the team.
                    </>
                }
                onConfirm={async () => {
                    await removeMember.mutateAsync({ teamId: team.id, userId: removing.userId });
                }}
                confirmText="Remove"
                destructive
            />
        </div>
    );
}
