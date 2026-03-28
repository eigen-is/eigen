import { createRootRouteWithContext, Outlet, useLocation } from '@tanstack/react-router';
import type { AuthContextType } from '@workspace/lib/auth';
import { useAddTeamMember, usePeopleTeams } from '@workspace/lib/people';
import { usePublicConfig } from '@workspace/lib/public';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { PeopleSidebar } from '../components/people/people-sidebar';

interface MyRouterContext {
    auth: AuthContextType;
}

function PeopleRoot() {
    const { data: config } = usePublicConfig();
    const { data: teams = [] } = usePeopleTeams(config?.orgId);
    const addMember = useAddTeamMember(config?.orgId);
    const location = useLocation();

    // Check if we're on the teams route with a teamId selected
    const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;

    const handleAddMembersToTeam = async (memberIds: string[], teamId: string) => {
        for (const userId of memberIds) {
            await addMember.mutateAsync({ teamId, userId });
        }
    };

    return (
        <AppShell
            appName="people"
            rootRoute={Route}
            sidebarMode={isTeamDetailSelected ? 'hidden' : 'collapsible'}
            sidebar={({ condensed, isMobile, onClose }) => (
                <PeopleSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    teams={teams}
                    onAddMembersToTeam={handleAddMembersToTeam}
                />
            )}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: PeopleRoot,
});
