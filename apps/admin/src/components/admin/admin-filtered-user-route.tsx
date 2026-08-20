import { useNavigate } from '@tanstack/react-router';
import { useAdminGuests, useDeleteUser } from '@workspace/lib/admin';
import { Column, ColumnLayout, EmptyState, LoadingState } from '@workspace/ui';
import { useState } from 'react';
import { AdminUserDetail, AdminUserDetailToolbar, AdminUserList, AdminUserListToolbar } from './admin-user-list';

export type AdminFilteredUserSearch = { userId?: string };

type AdminGuestsRouteProps = {
    userId?: string;
};

// List/detail page for the guests route.
export function AdminFilteredUserRoute({ userId }: AdminGuestsRouteProps) {
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const { data: users = [], isLoading } = useAdminGuests();
    const deleteUser = useDeleteUser();

    const user = users.find((u) => u.id === userId);

    const handleDelete = async () => {
        if (!user) return;
        await deleteUser.mutateAsync(user.id);
        navigate({ to: '/guests', search: {} });
    };

    if (isLoading) return <LoadingState />;

    return (
        <ColumnLayout mobileColumn={userId ? 'detail' : 'list'}>
            <Column
                id="list"
                width="350px"
                onBack="sidebar"
                toolbar={
                    <AdminUserListToolbar
                        searchQuery={searchQuery}
                        onSearchChange={setSearchQuery}
                        placeholder="Search guests..."
                    />
                }
            >
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <AdminUserList
                        users={users}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to: '/guests', search: { userId: id } })}
                        emptyMessage="No guest users"
                    />
                </div>
            </Column>
            <Column
                id="detail"
                width="flex"
                onBack={() => navigate({ to: '/guests', search: {} })}
                toolbar={user ? <AdminUserDetailToolbar user={user} onDelete={handleDelete} /> : undefined}
            >
                {user ? <AdminUserDetail user={user} /> : <EmptyState message="Select a guest to view details" />}
            </Column>
        </ColumnLayout>
    );
}
