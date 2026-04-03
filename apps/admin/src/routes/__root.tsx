import { createRootRouteWithContext, Outlet, useLocation } from '@tanstack/react-router';
import { useAddTeamMember, useMembers, useSetupStatus, useTeams } from '@workspace/lib/admin';
import { type AuthContextType, useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { LoadingState } from '@workspace/ui';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { AdminSidebar } from '../components/admin/admin-sidebar.tsx';
import { SetupWizard } from '../components/admin/setup-wizard.tsx';

interface MyRouterContext {
    auth: AuthContextType;
}

function AdminRoot() {
    const { data: setupStatus, isLoading: setupLoading } = useSetupStatus();

    if (setupLoading) return <LoadingState />;
    if (setupStatus?.setupRequired) return <SetupWizard />;

    return <AdminApp />;
}

function AdminApp() {
    const { user } = useAuth();

    if (!user) {
        return (
            <AppShell appName="admin" rootRoute={Route}>
                <Outlet />
            </AppShell>
        );
    }

    return <AuthenticatedAdmin />;
}

function AuthenticatedAdmin() {
    const { user } = useAuth();
    const { data: config } = usePublicConfig();
    const { data: teams = [] } = useTeams(config?.orgId);
    const { data: members = [] } = useMembers(config?.orgId);
    const addMember = useAddTeamMember(config?.orgId);
    const location = useLocation();

    const currentMember = members.find((m) => m.userId === user?.id);
    const isOwner = currentMember?.role === 'owner';

    const isTeamDetailSelected = location.pathname === '/teams' && location.search.teamId;

    const handleAddMembersToTeam = async (memberIds: string[], teamId: string) => {
        for (const userId of memberIds) {
            await addMember.mutateAsync({ teamId, userId });
        }
    };

    return (
        <AppShell
            appName="admin"
            rootRoute={Route}
            sidebarMode={isTeamDetailSelected ? 'hidden' : 'collapsible'}
            sidebar={({ condensed, isMobile, onClose }) => (
                <AdminSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    teams={teams}
                    isOwner={isOwner}
                    onAddMembersToTeam={handleAddMembersToTeam}
                />
            )}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: AdminRoot,
});
