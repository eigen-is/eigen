import { useNavigate } from '@tanstack/react-router';
import { useDeleteUser, useUpdateMemberRole } from '@workspace/lib/admin';
import { formatDate } from '@workspace/lib/date';
import type { OrgMember } from '@workspace/lib/types/admin';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { DangerZone } from '@workspace/ui/components/delete/danger-zone';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { UserDetailHero } from '@workspace/ui/components/user/user-detail-hero';
import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ResetPasswordDialog } from './reset-password-dialog';

type MemberDetailToolbarProps = {
    member: OrgMember;
};

export function MemberDetailToolbar({ member }: MemberDetailToolbarProps) {
    const [showResetPassword, setShowResetPassword] = useState(false);

    if (member.role === 'owner') return null;

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={KeyRound} tooltipText="Reset password" onClick={() => setShowResetPassword(true)} />
            <ResetPasswordDialog
                open={showResetPassword}
                onOpenChange={setShowResetPassword}
                userId={member.userId}
                userName={member.name}
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
        <div className="app-gutter space-y-6">
            <UserDetailHero name={member.name} email={member.email} userId={member.userId} subtitle={member.email} />

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
