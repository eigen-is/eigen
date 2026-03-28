import { useNavigate } from '@tanstack/react-router';
import { useDeleteUser, useRemoveMember, useUpdateMemberRole } from '@workspace/lib/people';
import type { OrgMember } from '@workspace/lib/types/people';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { UserAvatar } from '@workspace/ui/components/layout/user-avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResetPasswordDialog } from './reset-password-dialog';

interface MemberDetailToolbarProps {
    member: OrgMember;
    organizationId?: string;
}

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

interface MemberDetailProps {
    member: OrgMember;
    organizationId?: string;
}

export function MemberDetail({ member, organizationId }: MemberDetailProps) {
    const [showDelete, setShowDelete] = useState(false);
    const updateRole = useUpdateMemberRole(organizationId);
    const deleteUser = useDeleteUser(organizationId);
    const navigate = useNavigate();

    const handleRoleChange = async (newRole: 'admin' | 'member' | 'owner') => {
        await updateRole.mutateAsync({ memberId: member.id, role: newRole });
    };

    const handleDelete = async () => {
        await deleteUser.mutateAsync(member.userId);
        navigate({ to: '/members', search: {} });
    };

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-start gap-4">
                <UserAvatar email={member.email} imageUrl={member.image ?? undefined} size="lg" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-semibold truncate">{member.name}</h2>
                    <p className="text-muted-foreground truncate">{member.email}</p>
                </div>
            </div>

            <div className="space-y-4">
                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Role</h3>
                    {member.role === 'owner' ? (
                        <Badge variant="default">owner</Badge>
                    ) : (
                        <Select
                            value={member.role}
                            onValueChange={(v) => handleRoleChange(v as 'admin' | 'member' | 'owner')}
                            disabled={updateRole.isPending}
                        >
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
                    <p className="text-sm">{member.createdAt.toLocaleDateString()}</p>
                </div>
            </div>

            {member.role !== 'owner' && (
                <div className="border-t pt-6">
                    <h3 className="text-sm font-medium text-destructive mb-2">Danger zone</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                        Permanently delete this user account and all associated data.
                    </p>
                    <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>
                        Delete user
                    </Button>
                    <DeleteDialog
                        open={showDelete}
                        onOpenChange={setShowDelete}
                        title="Delete User"
                        description={`Permanently delete ${member.name} and all their data? This removes the user account, files, emails, contacts, and calendars. This cannot be undone.`}
                        onDelete={handleDelete}
                    />
                </div>
            )}
        </div>
    );
}
