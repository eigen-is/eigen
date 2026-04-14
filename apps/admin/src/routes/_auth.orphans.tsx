import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { adminKeys, useAdminUsers, useDeleteUser } from '@workspace/lib/admin';
import { EmptyState, LoadingState } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { useState } from 'react';
import {
    AdminUserDetail,
    AdminUserDetailToolbar,
    AdminUserList,
    AdminUserListToolbar,
} from '../components/admin/admin-user-list';

type OrphansSearch = { userId?: string };

export const Route = createFileRoute('/_auth/orphans')({
    component: OrphansRoute,
    validateSearch: (search: Record<string, unknown>): OrphansSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function OrphansRoute() {
    const { userId } = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const queryClient = useQueryClient();
    const { data: users = [], isLoading } = useAdminUsers('orphan');
    const deleteUser = useDeleteUser();

    const user = users.find((u) => u.id === userId);

    const handleDelete = async () => {
        if (!user) return;
        await deleteUser.mutateAsync(user.id);
        queryClient.invalidateQueries({ queryKey: [...adminKeys.all, 'users'] });
        navigate({ to: '/orphans', search: {} });
    };

    if (isLoading) return <LoadingState />;

    return (
        <ColumnLayout mobileColumn={userId ? 'detail' : 'list'}>
            <Column
                id="list"
                width="350px"
                toolbar={
                    <AdminUserListToolbar
                        searchQuery={searchQuery}
                        onSearchChange={setSearchQuery}
                        placeholder="Search orphan users..."
                    />
                }
            >
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <AdminUserList
                        users={users}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to: '/orphans', search: { userId: id } })}
                        emptyMessage="No orphan users."
                    />
                </div>
            </Column>
            <Column
                id="detail"
                width="flex"
                onBack={() => navigate({ to: '/orphans', search: {} })}
                toolbar={user ? <AdminUserDetailToolbar user={user} onDelete={handleDelete} /> : undefined}
            >
                {user ? (
                    <AdminUserDetail user={user} onDelete={handleDelete} />
                ) : (
                    <EmptyState message="Select a user to view details" />
                )}
            </Column>
        </ColumnLayout>
    );
}
