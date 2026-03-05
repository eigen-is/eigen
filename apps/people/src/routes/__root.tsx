import {createRootRouteWithContext, Outlet, useLocation} from '@tanstack/react-router';
import {AuthContextType} from '@workspace/lib/auth';
import {usePublicConfig} from '@workspace/lib/public';
import {useAddTeamMember, usePeopleTeams} from '@workspace/lib/people';
import {AppShell} from '@workspace/ui/components/layout/app/app-shell.tsx';
import {PeopleSidebar} from '../components/people/people-sidebar';
import {toast} from 'sonner';

interface MyRouterContext {
    auth: AuthContextType;
}

function PeopleRoot() {
    const {data: config} = usePublicConfig();
    const {data: teams = []} = usePeopleTeams(config?.orgId);
    const addMember = useAddTeamMember();
    const location = useLocation();

    // Check if we're on the teams route with a teamId selected
    const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;

    const handleAddMembersToTeam = async (memberIds: string[], teamId: string) => {
        const team = teams.find(t => t.id === teamId);
        for (const userId of memberIds) {
            try {
                await addMember.mutateAsync({teamId, userId});
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Failed to add member to team');
                return;
            }
        }
        toast.success(`Added ${memberIds.length} member${memberIds.length > 1 ? 's' : ''} to ${team?.name ?? 'team'}`);
    };

    return (
        <AppShell
            appName="people"
            rootRoute={Route}
            sidebarMode={isTeamDetailSelected ? 'hidden' : 'collapsible'}
            sidebar={({condensed, isMobile, onClose}) => (
                <PeopleSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    teams={teams}
                    onAddMembersToTeam={handleAddMembersToTeam}
                />
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: PeopleRoot,
});
