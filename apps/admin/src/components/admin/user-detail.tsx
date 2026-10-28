// The detail of one account on the Admin app's users and guests pages: its role and activity, then its
// teams, storage and backups as sections like a team's detail, and a danger zone that deletes it. The
// toolbar above it resets a password. The users page shows it beside the list when the URL names an
// account.

import { useNavigate } from '@tanstack/react-router';
import { useDeleteUser, useUpdateMemberRole } from '@workspace/lib/admin';
import { useAuth } from '@workspace/lib/auth';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { TooltipButton } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { DangerZone } from '@workspace/ui/components/delete/danger-zone';
import { StorageUsageBars } from '@workspace/ui/components/home';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { UserDetailHero } from '@workspace/ui/components/user';
import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BackupSection } from './backup-section';
import { ResetPasswordDialog } from './reset-password-dialog';
import { UserTeamsSection } from './user-teams-section';

type UserDetailToolbarProps = {
    user: AdminUserRow;
    // A guest signs in with an emailed code, so there is no password to reset.
    guest?: boolean;
};

export function UserDetailToolbar({ user, guest }: UserDetailToolbarProps) {
    const { user: me } = useAuth();
    const [showResetPassword, setShowResetPassword] = useState(false);

    return (
        <div className="flex items-center gap-1 ml-auto">
            {!guest && (user.role !== 'owner' || user.id === me?.id) && (
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
        </div>
    );
}

type UserDetailProps = {
    user: AdminUserRow;
    usage?: HomeSizeResponse;
    organizationId?: string;
    // A guest has no role, teams, storage or backup: it only reaches what others shared with it.
    guest?: boolean;
};

export function UserDetail({ user, usage, organizationId, guest }: UserDetailProps) {
    const [draftRole, setDraftRole] = useState(user.role);
    const updateRole = useUpdateMemberRole(organizationId);
    const deleteUser = useDeleteUser(organizationId);
    const navigate = useNavigate();

    const hasChanges = draftRole !== user.role;

    useEffect(() => {
        setDraftRole(user.role);
    }, [user.id, user.role]);

    const handleSave = () => {
        // Both are set wherever the select that changes the draft is rendered: a user with no
        // organization row has no role to pick and no member row to change.
        if (!user.memberId || !draftRole) return;
        updateRole.mutate({ memberId: user.memberId, userId: user.id, role: draftRole });
    };

    const handleCancel = () => {
        setDraftRole(user.role);
    };

    const handleDelete = async () => {
        await deleteUser.mutateAsync(user.id);
        navigate({ to: guest ? '/guests' : '/users', search: {} });
    };

    return (
        <div className="app-gutter space-y-6 h-full overflow-y-auto">
            <UserDetailHero name={user.name} email={user.email} userId={user.id} subtitle={user.email} />

            <div className="space-y-4">
                {!guest && (
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Role</span>
                        {user.role === null ? (
                            <span className="text-sm text-muted-foreground">No organization</span>
                        ) : user.role === 'owner' ? (
                            <Badge variant="default">owner</Badge>
                        ) : (
                            <Select
                                value={draftRole ?? undefined}
                                // The two items below are the whole of what this can hand back.
                                onValueChange={(value) => setDraftRole(value === 'admin' ? 'admin' : 'member')}
                            >
                                <SelectTrigger className="w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="admin">Admin</SelectItem>
                                    <SelectItem value="member">Member</SelectItem>
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                )}
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">Last active</span>
                    <span className="text-sm">{user.lastActiveAt ? formatTimeAgo(user.lastActiveAt) : '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">Joined</span>
                    <span className="text-sm">{formatDate(user.createdAt)}</span>
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

            {/* Only a member of the organization can join one of its teams. */}
            {!guest && user.role !== null && (
                <>
                    <Separator />
                    <UserTeamsSection user={user} organizationId={organizationId} />
                </>
            )}

            {!guest && (
                <>
                    <Separator />
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium">Storage</h3>
                        {usage ? <StorageUsageBars data={usage} /> : <p className="text-sm text-muted-foreground">—</p>}
                    </div>

                    <Separator />
                    <BackupSection ownerId={user.id} />
                </>
            )}

            {/* DangerZone brings its own top rule. */}
            {user.role !== 'owner' && (
                <DangerZone
                    description="Permanently delete this user account and all associated data."
                    buttonLabel="Delete user"
                    confirmTitle="Delete user"
                    confirmDescription={`Permanently delete ${user.name} and all their data? This removes the user account, files, emails, contacts, and calendars. This cannot be undone.`}
                    onConfirm={handleDelete}
                />
            )}
        </div>
    );
}
