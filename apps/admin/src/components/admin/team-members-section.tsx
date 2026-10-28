// The Members section of a team's detail in the Admin app: the team's members, each with a button that
// takes them out, and an Add button that picks one of the organization's members to join. The
// organization's default team, which every user joins, has no remove buttons. A user's detail has the
// same section the other way round, the teams that user is in.

import { useAddTeamMembers, useMembers, useRemoveTeamMember } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { useTeamMembers } from '@workspace/lib/team';
import { EmptyState, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { UserItem } from '@workspace/ui/components/user';
import { UserRoundPlus, X } from 'lucide-react';
import { useState } from 'react';
import { AddMemberDialog } from './add-member-dialog';

type TeamMembersSectionProps = {
    teamId: string;
    organizationId?: string;
};

export function TeamMembersSection({ teamId, organizationId }: TeamMembersSectionProps) {
    const [showAddDialog, setShowAddDialog] = useState(false);

    const { data: teamMembers = [] } = useTeamMembers(teamId);
    const { data: allMembers = [] } = useMembers(organizationId);
    const addMembers = useAddTeamMembers();
    const removeMember = useRemoveTeamMember();
    const { data: config } = usePublicConfig();
    const isDefaultTeam = teamId === config?.defaultTeamId;

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
                availableMembers={availableMembers}
                onAdd={(userId) => addMembers.mutate({ teamId, userIds: [userId] })}
            />

            {teamMembers.length === 0 ? (
                <EmptyState icon={<UserRoundPlus className="h-6 w-6" />} message="No members in this team yet" />
            ) : (
                <div className="divide-y">
                    {[...teamMembers]
                        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
                        .map((tm) => (
                            <div key={tm.userId} className="flex items-center gap-3 py-2">
                                <UserItem
                                    name={tm.name ?? 'Unknown'}
                                    email={tm.email ?? ''}
                                    userId={tm.userId}
                                    className="flex-1 min-w-0"
                                />
                                {!isDefaultTeam && (
                                    <TooltipButton
                                        icon={X}
                                        tooltipText="Remove from team"
                                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => removeMember.mutate({ teamId, userId: tm.userId })}
                                    />
                                )}
                            </div>
                        ))}
                </div>
            )}
        </div>
    );
}
