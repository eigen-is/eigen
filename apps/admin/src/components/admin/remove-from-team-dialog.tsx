// The question before a member leaves a team, asked from both sides of a membership: a team's Members section and a
// user's Teams section. A removal can't be undone, since the member loses what is shared with the team, so it asks.

import { useRemoveTeamMember } from '@workspace/lib/admin';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';

type RemoveFromTeamDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    team: { id: string; name: string };
    member: { userId: string; name: string };
};

export function RemoveFromTeamDialog({ open, onOpenChange, team, member }: RemoveFromTeamDialogProps) {
    const removeMember = useRemoveTeamMember();
    return (
        <ConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Remove from team"
            description={
                <>
                    Remove <strong>{member.name}</strong> from <strong>{team.name}</strong>? They lose access to what is
                    shared with the team.
                </>
            }
            onConfirm={async () => {
                await removeMember.mutateAsync({ teamId: team.id, userId: member.userId });
            }}
            confirmText="Remove"
            destructive
        />
    );
}
