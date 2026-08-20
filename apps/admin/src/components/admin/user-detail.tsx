import { useNavigate } from '@tanstack/react-router';
import { useDeleteUser, useUpdateMemberRole } from '@workspace/lib/admin';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { TooltipButton, useLayout } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { DangerZone } from '@workspace/ui/components/delete/danger-zone';
import { getStorageUsageColor } from '@workspace/ui/components/home';
import { Progress } from '@workspace/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { UserDetailHero } from '@workspace/ui/components/user';
import { KeyRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ResetPasswordDialog } from './reset-password-dialog';

type UserDetailToolbarProps = {
    user: AdminUserRow;
    onClose: () => void;
};

export function UserDetailToolbar({ user, onClose }: UserDetailToolbarProps) {
    const { isMobile } = useLayout();
    const [showResetPassword, setShowResetPassword] = useState(false);

    return (
        <div className="flex items-center gap-1 ml-auto">
            {user.role !== 'owner' && (
                <>
                    <TooltipButton
                        icon={KeyRound}
                        tooltipText="Reset password"
                        onClick={() => setShowResetPassword(true)}
                    />
                    <ResetPasswordDialog
                        open={showResetPassword}
                        onOpenChange={setShowResetPassword}
                        userId={user.id}
                        userName={user.name}
                    />
                </>
            )}
            {!isMobile && <TooltipButton icon={X} tooltipText="Close" onClick={onClose} />}
        </div>
    );
}

type UserDetailProps = {
    user: AdminUserRow;
    usage?: HomeSizeResponse;
    organizationId?: string;
};

export function UserDetail({ user, usage, organizationId }: UserDetailProps) {
    const [draftRole, setDraftRole] = useState(user.role);
    const updateRole = useUpdateMemberRole(organizationId);
    const deleteUser = useDeleteUser(organizationId);
    const navigate = useNavigate();

    const hasChanges = draftRole !== user.role;

    // Reset draft when switching users
    useEffect(() => {
        setDraftRole(user.role);
    }, [user.id, user.role]);

    const handleSave = async () => {
        await updateRole.mutateAsync({
            memberId: user.memberId!,
            userId: user.id,
            role: draftRole as 'admin' | 'member' | 'owner',
        });
    };

    const handleCancel = () => {
        setDraftRole(user.role);
    };

    const handleDelete = async () => {
        await deleteUser.mutateAsync(user.id);
        navigate({ to: '/users', search: {} });
    };

    // Clamp: over-quota users exist in prod, and Progress must not exceed 100%.
    const ratio = usage && usage.total.max > 0 ? Math.min(usage.total.used / usage.total.max, 1) : 0;

    return (
        <div className="app-gutter space-y-6">
            <UserDetailHero name={user.name} email={user.email} userId={user.id} subtitle={user.email} />

            <div className="space-y-4">
                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Role</h3>
                    {user.role === null ? (
                        <p className="text-sm text-muted-foreground">
                            No organisation — this user is not a member of the organisation
                        </p>
                    ) : user.role === 'owner' ? (
                        <Badge variant="default">owner</Badge>
                    ) : (
                        <Select
                            value={draftRole ?? undefined}
                            onValueChange={(v) => setDraftRole(v as 'admin' | 'member')}
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
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Teams</h3>
                    <p className="text-sm">{user.teams.length > 0 ? user.teams.join(', ') : '—'}</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-2">Last active</h3>
                        <p className="text-sm">{user.lastActiveAt ? formatTimeAgo(user.lastActiveAt) : '—'}</p>
                    </div>
                    <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-2">Joined</h3>
                        <p className="text-sm">{formatDate(user.createdAt)}</p>
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Storage</h3>
                    {usage ? (
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between text-sm mb-1">
                                    <span className="text-muted-foreground">Total</span>
                                    <span>
                                        {formatFileSize(usage.total.used)} / {formatFileSize(usage.total.max)}
                                    </span>
                                </div>
                                <Progress
                                    value={ratio * 100}
                                    indicatorClassName={getStorageUsageColor(ratio)}
                                    className="h-1.5"
                                />
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Drive</span>
                                <span>{formatFileSize(usage.drive.default.used)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Mail & contacts</span>
                                <span>{formatFileSize(usage.mailAndContacts.used)}</span>
                            </div>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">—</p>
                    )}
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

            {user.role !== 'owner' && (
                <DangerZone
                    description="Permanently delete this user account and all associated data."
                    buttonLabel="Delete user"
                    confirmTitle="Delete User"
                    confirmDescription={`Permanently delete ${user.name} and all their data? This removes the user account, files, emails, contacts, and calendars. This cannot be undone.`}
                    onConfirm={handleDelete}
                />
            )}
        </div>
    );
}
