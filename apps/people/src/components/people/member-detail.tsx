import {useState} from 'react';
import {UserAvatar} from '@workspace/ui/components/layout/user-avatar';
import {Badge} from '@workspace/ui/components/badge';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Trash2} from 'lucide-react';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {TooltipButton} from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import {useUpdateMemberRole, useRemoveMember} from '@workspace/lib/people';
import {useNavigate} from '@tanstack/react-router';
import {toast} from 'sonner';
import type {OrgMember} from '@workspace/lib/types/people';

interface MemberDetailToolbarProps {
    member: OrgMember;
    organizationId?: string;
}

export function MemberDetailToolbar({member, organizationId}: MemberDetailToolbarProps) {
    const [showDelete, setShowDelete] = useState(false);
    const removeMember = useRemoveMember(organizationId);
    const navigate = useNavigate();

    const handleRemove = async () => {
        try {
            await removeMember.mutateAsync(member.id);
            toast.success(`${member.name} removed from organization`);
            navigate({to: '/members', search: {}});
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to remove member');
        }
    };

    if (member.role === 'owner') return null;

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={Trash2} tooltipText="Remove member" onClick={() => setShowDelete(true)}/>
            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Remove Member"
                description={`Remove ${member.name} from the organization? This cannot be undone.`}
                onDelete={handleRemove}
            />
        </div>
    );
}

interface MemberDetailProps {
    member: OrgMember;
    organizationId?: string;
}

export function MemberDetail({member, organizationId}: MemberDetailProps) {
    const updateRole = useUpdateMemberRole(organizationId);

    const handleRoleChange = async (newRole: 'admin' | 'member' | 'owner') => {
        try {
            await updateRole.mutateAsync({memberId: member.id, role: newRole});
            toast.success(`Role updated to ${newRole}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to update role');
        }
    };

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-start gap-4">
                <UserAvatar email={member.email} imageUrl={member.image ?? undefined} size="lg"/>
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
                        <Select value={member.role} onValueChange={(v) => handleRoleChange(v as 'admin' | 'member' | 'owner')} disabled={updateRole.isPending}>
                            <SelectTrigger className="w-40">
                                <SelectValue/>
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
        </div>
    );
}
