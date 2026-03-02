import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';
import {AuthContextType, useOrganization} from '@workspace/lib/auth';
import {usePeopleTeams, useAddTeamMember} from '@workspace/lib/people';
import {AppShell} from '@workspace/ui/components/layout/app-shell';
import {PeopleSidebar} from '../components/people/people-sidebar';
import {toast} from 'sonner';
import {useLocation} from '@tanstack/react-router';

interface MyRouterContext {
    auth: AuthContextType;
}

function PeopleRoot() {
    const {data: org} = useOrganization();
    const {data: teams = []} = usePeopleTeams(org?.id);
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
