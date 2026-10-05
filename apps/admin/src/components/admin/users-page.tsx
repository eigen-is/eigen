import { useNavigate } from '@tanstack/react-router';
import { usePublicConfig } from '@workspace/lib/public';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { Column, ColumnLayout, EmptyState, LoadingState } from '@workspace/ui';
import { cn } from '@workspace/ui/lib/utils';
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

// The users page and the guests page: the list, and the selected account's detail beside it.
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

    const detailToolbar = selected ? (
        <UserDetailToolbar user={selected} onClose={handleBackToList} guest={guests} />
    ) : null;

    return (
        <ColumnLayout mobileColumn={userId ? 'detail' : 'list'}>
            <Column id="list" width={userId ? '350px' : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                <div className={cn('flex h-full flex-col overflow-y-auto', userId && 'border-r')}>
                    <AdminUsersTable
                        users={users}
                        usage={usage}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to, search: { userId: id } })}
                        guests={guests}
                    />
                </div>
            </Column>
            {userId && (
                <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                    {selected ? (
                        <UserDetail
                            user={selected}
                            usage={usage?.[selected.id]}
                            organizationId={config?.orgId}
                            guest={guests}
                        />
                    ) : (
                        <EmptyState message={guests ? 'Guest not found' : 'User not found'} />
                    )}
                </Column>
            )}
        </ColumnLayout>
    );
}
