import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {TeamDetail, TeamDetailToolbar} from '../components/people/team-detail';
import {usePeopleTeams} from '@workspace/lib/people';
import {useOrganization} from '@workspace/lib/auth';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/column-layout';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';
import {Button} from '@workspace/ui/components/button';
import {ArrowLeft} from 'lucide-react';

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

    const {data: org} = useOrganization();
    const {data: teams = [], isLoading} = usePeopleTeams(org?.id);

    const team = teams.find(t => t.id === teamId);

    const handleBackToList = () => {
        navigate({to: '/teams', search: {}});
    };

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const detailToolbar = team ? (
        <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={handleBackToList}>
                <ArrowLeft className="h-4 w-4"/>
            </Button>
            <div className="flex-1">
                <TeamDetailToolbar team={team} organizationId={org?.id}/>
            </div>
        </div>
    ) : null;

    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={detailToolbar}>
                {team ? (
                    <TeamDetail team={team} organizationId={org?.id}/>
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select a team from the sidebar to view details</p>
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
