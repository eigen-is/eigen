// The Admin app's teams page: the organization's teams as a list, like the users page. The team the
// URL's teamId names opens its detail beside the list, where the admin edits its settings, drives,
// backups and members.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTeams } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { useDetailHistory } from '@workspace/ui/hooks/use-detail-history';
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
    const { data: config } = usePublicConfig();
    if (!config) return <LoadingState />;
    return <TeamsPage organizationId={config.orgId} />;
}

function TeamsPage({ organizationId }: { organizationId: string }) {
    const { teamId } = Route.useSearch();
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const { data: teams = [], isLoading } = useTeams(organizationId);

    const detail = useDetailHistory<string>(teamId !== undefined, (next, { replace, state }) =>
        navigate({ to: '/teams', search: (prev) => ({ ...prev, teamId: next }), replace, state }),
    );

    const team = teams.find((t) => t.id === teamId);

    if (isLoading) {
        return <LoadingState />;
    }

    const listToolbar = (
        <AdminTeamsToolbar searchQuery={searchQuery} onSearchChange={setSearchQuery} organizationId={organizationId} />
    );

    const detailToolbar = team ? <TeamDetailToolbar team={team} organizationId={organizationId} /> : null;

    return (
        <ListDetailLayout
            listToolbar={listToolbar}
            detail={
                teamId &&
                (team ? (
                    // key: remount per team so per-team state (drafts, avatar ?v= stamp) resets and
                    // an in-flight avatar mutation can't write the previous team's URL into the new one.
                    <TeamDetail key={team.id} team={team} organizationId={organizationId} />
                ) : (
                    <EmptyState message="Team not found" />
                ))
            }
            detailToolbar={detailToolbar}
            onClose={detail.close}
        >
            <AdminTeamsTable teams={teams} searchQuery={searchQuery} activeTeamId={teamId} onRowClick={detail.open} />
        </ListDetailLayout>
    );
}
