// The detail of one team on the Admin app's teams page: its name, avatar and settings, then its mounts,
// backups and members as sections, and the toolbar above it that deletes the team. A user's detail
// has the same section layout, so the two read as one design.

import { useNavigate } from '@tanstack/react-router';
import { useRemoveTeam } from '@workspace/lib/admin';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { DeleteDialog, TooltipButton } from '@workspace/ui';
import { Separator } from '@workspace/ui/components/separator';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BackupSection } from './backup-section';
import { TeamMembersSection } from './team-members-section';
import { TeamMountsSection } from './team-mounts-section';
import { TeamSettingsSection } from './team-settings-section';

type TeamDetailToolbarProps = {
    team: OrgTeam;
    organizationId?: string;
};

export function TeamDetailToolbar({ team, organizationId }: TeamDetailToolbarProps) {
    const [showDelete, setShowDelete] = useState(false);
    const removeTeam = useRemoveTeam(organizationId);
    const navigate = useNavigate();

    const handleRemove = async () => {
        await removeTeam.mutateAsync(team.id);
        navigate({ to: '/teams', search: {} });
    };

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={Trash2} tooltipText="Delete team" onClick={() => setShowDelete(true)} />
            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Delete team"
                description={`Delete team "${team.name}"? Its drives, their files and its calendar are deleted too. This cannot be undone.`}
                onDelete={handleRemove}
            />
        </div>
    );
}

type TeamDetailProps = {
    team: OrgTeam;
    organizationId?: string;
};

export function TeamDetail({ team, organizationId }: TeamDetailProps) {
    return (
        <div className="app-gutter space-y-6 h-full overflow-y-auto">
            <TeamSettingsSection team={team} organizationId={organizationId} />

            <Separator />

            <TeamMountsSection teamId={team.id} />

            <Separator />

            <BackupSection ownerId={teamOwnerId(team.id)} />

            <Separator />

            <TeamMembersSection teamId={team.id} organizationId={organizationId} />
        </div>
    );
}
