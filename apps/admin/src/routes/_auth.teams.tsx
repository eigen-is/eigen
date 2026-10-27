// The Admin app's teams page: the organization's teams as a list, like the users page. The team the
// URL's teamId names opens its detail beside the list, where the admin edits its settings, drives,
// backups and members.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTeams } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui';
import { useState } from 'react';
import { TeamDetail, TeamDetailToolbar } from '../components/admin/team-detail';
import { AdminTeamsTable, AdminTeamsToolbar } from '../components/admin/teams-table';

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
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');

    const { data: config } = usePublicConfig();
    const { data: teams = [], isLoading } = useTeams(config?.orgId);

    const team = teams.find((t) => t.id === teamId);

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <AdminTeamsToolbar searchQuery={searchQuery} onSearchChange={setSearchQuery} organizationId={config?.orgId} />
    );

    const detailToolbar = team ? <TeamDetailToolbar team={team} organizationId={config?.orgId} /> : null;

    return (
        <ListDetailLayout
            listToolbar={listToolbar}
            detail={
                teamId &&
                (team ? (
                    // key: remount per team so per-team state (drafts, avatar ?v= stamp) resets and
                    // an in-flight avatar mutation can't write the previous team's URL into the new one.
                    <TeamDetail key={team.id} team={team} organizationId={config?.orgId} />
                ) : (
                    <EmptyState message="Team not found" />
                ))
            }
            detailToolbar={detailToolbar}
            onBackToList={() => navigate({ to: '/teams', search: {} })}
        >
            <AdminTeamsTable
                teams={teams}
                searchQuery={searchQuery}
                activeTeamId={teamId}
                onRowClick={(id) => navigate({ to: '/teams', search: { teamId: id } })}
            />
        </ListDetailLayout>
    );
}
