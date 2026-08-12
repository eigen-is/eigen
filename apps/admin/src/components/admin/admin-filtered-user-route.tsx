import { useNavigate } from '@tanstack/react-router';
import { useAdminUsers, useDeleteUser } from '@workspace/lib/admin';
import { EmptyState, LoadingState } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { useState } from 'react';
import { AdminUserDetail, AdminUserDetailToolbar, AdminUserList, AdminUserListToolbar } from './admin-user-list';

export type AdminFilteredUserSearch = { userId?: string };

type AdminFilteredUserRouteProps = {
    filter: 'guest' | 'orphan';
    routeTo: '/guests' | '/orphans';
    userId?: string;
    searchPlaceholder: string;
    listEmptyMessage: string;
    detailEmptyMessage: string;
};

/**
 * Shared list/detail page for a server-wide user classification (guests, orphans). The two admin
 * routes differ only in the filter passed to `useAdminUsers`, the route they navigate to, and their
 * per-page wording — everything else is this component.
 */
export function AdminFilteredUserRoute({
    filter,
    routeTo,
    userId,
    searchPlaceholder,
    listEmptyMessage,
    detailEmptyMessage,
}: AdminFilteredUserRouteProps) {
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const { data: users = [], isLoading } = useAdminUsers(filter);
    const deleteUser = useDeleteUser();

    const user = users.find((u) => u.id === userId);

    const handleDelete = async () => {
        if (!user) return;
        await deleteUser.mutateAsync(user.id);
        navigate({ to: routeTo, search: {} });
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
                        placeholder={searchPlaceholder}
                    />
                }
            >
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <AdminUserList
                        users={users}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to: routeTo, search: { userId: id } })}
                        emptyMessage={listEmptyMessage}
                    />
                </div>
            </Column>
            <Column
                id="detail"
                width="flex"
                onBack={() => navigate({ to: routeTo, search: {} })}
                toolbar={user ? <AdminUserDetailToolbar user={user} onDelete={handleDelete} /> : undefined}
            >
                {user ? <AdminUserDetail user={user} /> : <EmptyState message={detailEmptyMessage} />}
            </Column>
        </ColumnLayout>
    );
}
