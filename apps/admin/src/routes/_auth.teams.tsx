import { createFileRoute } from '@tanstack/react-router';
import { useTeams } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { EmptyState, LoadingState } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { TeamDetail, TeamDetailToolbar } from '../components/admin/team-detail';

type TeamsSearch = {
    teamId?: string;
};

export const Route = createFileRoute('/_auth/teams')({
    component: TeamsRoute,
    validateSearch: (search: Record<string, unknown>): TeamsSearch => ({
        teamId: typeof search.teamId === 'string' ? search.teamId : undefined,
    }),
});

function TeamsRoute() {
    const { teamId } = Route.useSearch();

    const { data: config } = usePublicConfig();
    const { data: teams = [], isLoading } = useTeams(config?.orgId);

    const team = teams.find((t) => t.id === teamId);

    if (isLoading) {
        return <LoadingState />;
    }

    const detailToolbar = team ? <TeamDetailToolbar team={team} organizationId={config?.orgId} /> : null;

    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={detailToolbar}>
                {team ? (
                    <TeamDetail team={team} organizationId={config?.orgId} />
                ) : (
                    <EmptyState message="Select a team from the sidebar to view details" />
                )}
            </Column>
        </ColumnLayout>
    );
}
