import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAdminGuests } from '@workspace/lib/admin';
import { Column, ColumnLayout, EmptyState, LoadingState, SearchBar } from '@workspace/ui';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import { UserDetail, UserDetailToolbar } from '../components/admin/user-detail';
import { AdminUsersTable } from '../components/admin/users-table';

type GuestsSearch = { userId?: string };

export const Route = createFileRoute('/_auth/guests')({
    component: GuestsRoute,
    validateSearch: (search: Record<string, unknown>): GuestsSearch => ({
        userId: typeof search.userId === 'string' ? search.userId : undefined,
    }),
});

function GuestsRoute() {
    const { userId } = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const { data: guests = [], isLoading } = useAdminGuests();

    const selected = guests.find((u) => u.id === userId);

    const handleBackToList = () => {
        navigate({ to: '/guests', search: {} });
    };

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <SearchBar
            placeholder="Search guests..."
            value={searchQuery}
            onChange={setSearchQuery}
            maxWidth="full"
            inputClassName="h-8 bg-background"
        />
    );

    const detailToolbar = selected ? <UserDetailToolbar user={selected} onClose={handleBackToList} guest /> : null;

    return (
        <ColumnLayout mobileColumn={userId ? 'detail' : 'list'}>
            <Column id="list" width={userId ? '350px' : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                <div className={cn('flex h-full flex-col overflow-y-auto', userId && 'border-r')}>
                    <AdminUsersTable
                        users={guests}
                        searchQuery={searchQuery}
                        activeUserId={userId}
                        onRowClick={(id) => navigate({ to: '/guests', search: { userId: id } })}
                        guests
                    />
                </div>
            </Column>
            {userId && (
                <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                    {selected ? <UserDetail user={selected} guest /> : <EmptyState message="Guest not found" />}
                </Column>
            )}
        </ColumnLayout>
    );
}
