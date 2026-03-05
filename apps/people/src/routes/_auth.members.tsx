import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {MembersList, MembersListToolbar} from '../components/people/members-list';
import {MemberDetail, MemberDetailToolbar} from '../components/people/member-detail';
import {usePeopleMembers} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/app/column-layout.tsx';
import {EigenLoader} from '@workspace/ui/components/layout/braket/eigen-loader.tsx';
import {useState} from 'react';

type MembersSearch = {
    memberId?: string;
}

export const Route = createFileRoute('/_auth/members')({
    component: MembersRoute,
    validateSearch: (search: Record<string, unknown>): MembersSearch => ({
        memberId: typeof search.memberId === 'string' ? search.memberId : undefined,
    }),
});

function MembersRoute() {
    const {memberId} = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const [showCreateDialog, setShowCreateDialog] = useState(false);

    const {data: config} = usePublicConfig();
    const {data: members = [], isLoading} = usePeopleMembers(config?.orgId);

    const member = members.find(m => m.id === memberId);

    const handleBackToList = () => {
        navigate({to: '/members', search: {}});
    };

    const handleRowClick = (id: string) => {
        navigate({to: '/members', search: {memberId: id}});
    };

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
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

    const detailToolbar = member ? (
        <MemberDetailToolbar member={member} organizationId={config?.orgId}/>
    ) : null;

    return (
        <ColumnLayout mobileColumn={memberId ? 'detail' : 'list'}>
            <Column id="list" width="350px" toolbar={listToolbar}>
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
                    <MemberDetail member={member} organizationId={config?.orgId}/>
                ) : (
                    <div className="flex-1 flex items-center justify-center">
                        <p className="text-muted-foreground text-center">Select a member to view details</p>
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
