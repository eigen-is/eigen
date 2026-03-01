import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {TeamsList, TeamsListToolbar} from '../components/people/teams-list';
import {TeamDetail, TeamDetailToolbar} from '../components/people/team-detail';
import {usePeopleTeams} from '@workspace/lib/people';
import {useOrganization} from '@workspace/lib/auth';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/column-layout';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';
import {useState} from 'react';

type TeamsSearch = {
    teamId?: string;
}

export const Route = createFileRoute('/_auth/teams')({
    component: TeamsRoute,
    validateSearch: (search: Record<string, unknown>): TeamsSearch => ({
        teamId: typeof search.teamId === 'string' ? search.teamId : undefined,
    }),
});

function TeamsRoute() {
    const {teamId} = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');

    const {data: org} = useOrganization();
    const {data: teams = [], isLoading} = usePeopleTeams(org?.id);

    const team = teams.find(t => t.id === teamId);

    const handleBackToList = () => {
        navigate({to: '/teams', search: {}});
    };

    const handleRowClick = (id: string) => {
        navigate({to: '/teams', search: {teamId: id}});
    };

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const listToolbar = (
        <TeamsListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            organizationId={org?.id}
        />
    );

    const detailToolbar = team ? (
        <TeamDetailToolbar team={team} organizationId={org?.id}/>
    ) : null;

    return (
        <ColumnLayout mobileColumn={teamId ? 'detail' : 'list'}>
            <Column id="list" width="350px" toolbar={listToolbar}>
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <TeamsList
                        teams={teams}
                        searchQuery={searchQuery}
                        activeTeamId={teamId}
                        onRowClick={handleRowClick}
                    />
                </div>
            </Column>
            <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                {team ? (
                    <TeamDetail team={team} organizationId={org?.id}/>
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select a team to view details</p>
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
