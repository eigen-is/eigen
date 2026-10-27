// The users page and the guests page of the Admin app share this component. It lists the accounts,
// and the account the URL's userId names opens its detail beside the list. The routes fetch the
// rows; this page owns the search text and the navigation between list and detail.

import { useNavigate } from '@tanstack/react-router';
import { usePublicConfig } from '@workspace/lib/public';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui';
import { useState } from 'react';
import { UserDetail, UserDetailToolbar } from './user-detail';
import { AdminUsersTable, AdminUsersToolbar } from './users-table';

type AdminUsersPageProps = {
    users: AdminUserRow[];
    isLoading: boolean;
    userId?: string;
    usage?: Record<string, HomeSizeResponse>;
    guests?: boolean;
};

export function AdminUsersPage({ users, isLoading, userId, usage, guests }: AdminUsersPageProps) {
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const { data: config } = usePublicConfig();

    const to = guests ? '/guests' : '/users';
    const selected = users.find((u) => u.id === userId);

    const handleBackToList = () => {
        navigate({ to, search: {} });
    };

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <AdminUsersToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            organizationId={config?.orgId}
            guests={guests}
        />
    );

    const detailToolbar = selected ? <UserDetailToolbar user={selected} guest={guests} /> : null;

    return (
        <ListDetailLayout
            listToolbar={listToolbar}
            detail={
                userId &&
                (selected ? (
                    <UserDetail
                        user={selected}
                        usage={usage?.[selected.id]}
                        organizationId={config?.orgId}
                        guest={guests}
                    />
                ) : (
                    <EmptyState message={guests ? 'Guest not found' : 'User not found'} />
                ))
            }
            detailToolbar={detailToolbar}
            onBackToList={handleBackToList}
        >
            <AdminUsersTable
                users={users}
                usage={usage}
                searchQuery={searchQuery}
                activeUserId={userId}
                onRowClick={(id) => navigate({ to, search: { userId: id } })}
                organizationId={config?.orgId}
                guests={guests}
            />
        </ListDetailLayout>
    );
}
