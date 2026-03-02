import {createFileRoute} from '@tanstack/react-router';
import {TeamDetail, TeamDetailToolbar} from '../components/people/team-detail';
import {usePeopleTeams} from '@workspace/lib/people';
import {useOrganization} from '@workspace/lib/auth';
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

    const {data: org} = useOrganization();
    const {data: teams = [], isLoading} = usePeopleTeams(org?.id);

    const team = teams.find(t => t.id === teamId);

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const detailToolbar = team ? (
        <TeamDetailToolbar team={team} organizationId={org?.id}/>
    ) : null;

    return (
        <div className="h-full flex flex-col">
            {detailToolbar && (
                <div className="border-b bg-background">
                    {detailToolbar}
                </div>
            )}
            <div className="flex-1">
                {team ? (
                    <TeamDetail team={team} organizationId={org?.id}/>
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select a team from the sidebar to view details</p>
                    </div>
                )}
            </div>
        </div>
    );
}
