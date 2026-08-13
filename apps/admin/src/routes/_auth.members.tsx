import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMembers } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { Column, ColumnLayout, EmptyState, LoadingState } from '@workspace/ui';
import { useState } from 'react';
import { MemberDetail, MemberDetailToolbar } from '../components/admin/member-detail';
import { MembersList, MembersListToolbar } from '../components/admin/members-list';

type MembersSearch = {
    memberId?: string;
};

export const Route = createFileRoute('/_auth/members')({
    component: MembersRoute,
    validateSearch: (search: Record<string, unknown>): MembersSearch => ({
        memberId: typeof search.memberId === 'string' ? search.memberId : undefined,
    }),
});

function MembersRoute() {
    const { memberId } = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const [showCreateDialog, setShowCreateDialog] = useState(false);

    const { data: config } = usePublicConfig();
    const { data: members = [], isLoading } = useMembers(config?.orgId);

    const member = members.find((m) => m.id === memberId);

    const handleBackToList = () => {
        navigate({ to: '/members', search: {} });
    };

    const handleRowClick = (id: string) => {
        navigate({ to: '/members', search: { memberId: id } });
    };

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <MembersListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showCreateDialog={showCreateDialog}
            onShowCreateDialog={setShowCreateDialog}
            organizationId={config?.orgId}
        />
    );

    const detailToolbar = member ? <MemberDetailToolbar member={member} /> : null;

    return (
        <ColumnLayout mobileColumn={memberId ? 'detail' : 'list'}>
            <Column id="list" width="350px" onBack="sidebar" toolbar={listToolbar}>
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <MembersList
                        members={members}
                        searchQuery={searchQuery}
                        activeMemberId={memberId}
                        onRowClick={handleRowClick}
                    />
                </div>
            </Column>
            <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                {member ? (
                    <MemberDetail member={member} organizationId={config?.orgId} />
                ) : (
                    <EmptyState message="Select a member to view details" />
                )}
            </Column>
        </ColumnLayout>
    );
}
