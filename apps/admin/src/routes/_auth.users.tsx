import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAdminUserList, useAdminUsersUsage } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { Column, ColumnLayout, EmptyState, LoadingState } from '@workspace/ui';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import { UserDetail, UserDetailToolbar } from '../components/admin/user-detail';
import { AdminUsersTable, AdminUsersToolbar } from '../components/admin/users-table';

type UsersSearch = {
    userId?: string;
};

export const Route = createFileRoute('/_auth/users')({
    component: UsersRoute,
    validateSearch: (search: Record<string, unknown>): UsersSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function UsersRoute() {
    const { userId } = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const [showCreateDialog, setShowCreateDialog] = useState(false);

    const { data: config } = usePublicConfig();
    const { data: users = [], isLoading } = useAdminUserList();
    const { data: usage } = useAdminUsersUsage();

    const selected = users.find((u) => u.id === userId);

    const handleBackToList = () => {
        navigate({ to: '/users', search: {} });
    };

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <AdminUsersToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showCreateDialog={showCreateDialog}
            onShowCreateDialog={setShowCreateDialog}
            organizationId={config?.orgId}
        />
    );

    const detailToolbar = selected ? <UserDetailToolbar user={selected} onClose={handleBackToList} /> : null;

    return (
        <ColumnLayout mobileColumn={userId ? 'detail' : 'list'}>
            <Column id="list" width={userId ? '350px' : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                <div className={cn('flex h-full flex-col overflow-y-auto', userId && 'border-r')}>
                    <AdminUsersTable
                        users={users}
                        usage={usage}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to: '/users', search: { userId: id } })}
                    />
                </div>
            </Column>
            {userId && (
                <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                    {selected ? (
                        <UserDetail user={selected} usage={usage?.[selected.id]} organizationId={config?.orgId} />
                    ) : (
                        <EmptyState message="User not found" />
                    )}
                </Column>
            )}
        </ColumnLayout>
    );
}
