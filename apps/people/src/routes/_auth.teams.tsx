import {createFileRoute} from '@tanstack/react-router';
import {TeamDetail, TeamDetailToolbar} from '../components/people/team-detail';
import {usePeopleTeams} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/column-layout';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';

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

    const {data: config} = usePublicConfig();
    const {data: teams = [], isLoading} = usePeopleTeams(config?.orgId);

    const team = teams.find(t => t.id === teamId);

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const detailToolbar = team ? (
        <TeamDetailToolbar team={team} organizationId={config?.orgId}/>
    ) : null;

    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={detailToolbar}>
                {team ? (
                    <TeamDetail team={team} organizationId={config?.orgId}/>
                ) : (
                    <div className="flex-1 flex items-center justify-center">
                        <p className="text-muted-foreground text-center">Select a team from the sidebar to view details</p>
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
