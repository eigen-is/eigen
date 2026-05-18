import { useNavigate } from '@tanstack/react-router';
import { useDeleteUser, useRemoveMember, useUpdateMemberRole } from '@workspace/lib/admin';
import { formatDate } from '@workspace/lib/date';
import type { OrgMember } from '@workspace/lib/types/admin';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { DangerZone } from '@workspace/ui/components/layout/delete/danger-zone';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { UserDetailHero } from '@workspace/ui/components/layout/user-detail-hero';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ResetPasswordDialog } from './reset-password-dialog';

type MemberDetailToolbarProps = {
    member: OrgMember;
    organizationId?: string;
};

export function MemberDetailToolbar({ member, organizationId }: MemberDetailToolbarProps) {
    const [showRemove, setShowRemove] = useState(false);
    const [showResetPassword, setShowResetPassword] = useState(false);
    const removeMember = useRemoveMember(organizationId);
    const navigate = useNavigate();

    const handleRemove = async () => {
        await removeMember.mutateAsync(member.id);
        navigate({ to: '/members', search: {} });
    };

    if (member.role === 'owner') return null;

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={KeyRound} tooltipText="Reset password" onClick={() => setShowResetPassword(true)} />
            <TooltipButton icon={Trash2} tooltipText="Remove from organization" onClick={() => setShowRemove(true)} />
            <ResetPasswordDialog
                open={showResetPassword}
                onOpenChange={setShowResetPassword}
                userId={member.userId}
                userName={member.name}
            />
            <DeleteDialog
                open={showRemove}
                onOpenChange={setShowRemove}
                title="Remove Member"
                description={`Remove ${member.name} from the organization? The user account and data will be preserved.`}
                onDelete={handleRemove}
            />
        </div>
    );
}

type MemberDetailProps = {
    member: OrgMember;
    organizationId?: string;
};

export function MemberDetail({ member, organizationId }: MemberDetailProps) {
    const [draftRole, setDraftRole] = useState(member.role);
    const updateRole = useUpdateMemberRole(organizationId);
    const deleteUser = useDeleteUser(organizationId);
    const navigate = useNavigate();

    const hasChanges = draftRole !== member.role;

    // Reset draft when switching members
    useEffect(() => {
        setDraftRole(member.role);
    }, [member.id, member.role]);

    const handleSave = async () => {
        await updateRole.mutateAsync({
            memberId: member.id,
            userId: member.userId,
            role: draftRole as 'admin' | 'member' | 'owner',
        });
    };

    const handleCancel = () => {
        setDraftRole(member.role);
    };

    const handleDelete = async () => {
        await deleteUser.mutateAsync(member.userId);
        navigate({ to: '/members', search: {} });
    };

    return (
        <div className="p-6 space-y-6">
            <UserDetailHero name={member.name} email={member.email} imageUrl={member.image} subtitle={member.email} />

            <div className="space-y-4">
                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Role</h3>
                    {member.role === 'owner' ? (
                        <Badge variant="default">owner</Badge>
                    ) : (
                        <Select value={draftRole} onValueChange={setDraftRole}>
                            <SelectTrigger className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                            </SelectContent>
                        </Select>
                    )}
                </div>

                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Joined</h3>
                    <p className="text-sm">{formatDate(member.createdAt)}</p>
                </div>
            </div>

            {hasChanges && (
                <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" onClick={handleCancel}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={updateRole.isPending}>
                        {updateRole.isPending ? 'Saving...' : 'Save'}
                    </Button>
                </div>
            )}

            {member.role !== 'owner' && (
                <DangerZone
                    description="Permanently delete this user account and all associated data."
                    buttonLabel="Delete user"
                    confirmTitle="Delete User"
                    confirmDescription={`Permanently delete ${member.name} and all their data? This removes the user account, files, emails, contacts, and calendars. This cannot be undone.`}
                    onConfirm={handleDelete}
                />
            )}
        </div>
    );
}
