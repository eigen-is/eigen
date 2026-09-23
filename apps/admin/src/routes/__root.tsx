import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAddTeamMember, useMembers, useSetupStatus, useTeams } from '@workspace/lib/admin';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { useServerSettings } from '@workspace/lib/settings';
import { AppShell, ErrorState, LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { AdminSidebar } from '../components/admin/admin-sidebar';
import { SetupWizard } from '../components/admin/setup-wizard';

// The token of the link ./eigen setup printed, in the fragment so it never reaches a server or proxy log. Read and
// taken off the URL before the router starts: its redirects (/ to /users, then to /login) would drop it, and off
// the URL it stays out of the history.
const setupToken = new URLSearchParams(window.location.hash.slice(1)).get('setup') ?? undefined;
if (setupToken) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

function AdminRoot() {
    const { data: setupStatus, isLoading, error, refetch } = useSetupStatus();

    if (isLoading) return <LoadingState />;
    if (error) {
        return (
            <ErrorState
                message="Could not check setup status."
                detail={error.message}
                action={<Button onClick={() => refetch()}>Try again</Button>}
            />
        );
    }
    // Never infer "configured" from absent data — only a resolved status decides.
    if (!setupStatus) return <LoadingState />;
    if (setupStatus.setupRequired) return <SetupWizard status={setupStatus} setupToken={setupToken} />;

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
    const addMember = useAddTeamMember();

    const { data: serverSettings } = useServerSettings();
    const currentMember = members.find((m) => m.userId === user?.id);
    const isOwner = currentMember?.role === 'owner';
    const waitlistEnabled = serverSettings?.onboarding?.waitlist?.enabled ?? false;

    const handleAddMembersToTeam = async (memberIds: string[], teamId: string) => {
        for (const userId of memberIds) {
            await addMember.mutateAsync({ teamId, userId });
        }
    };

    return (
        <AppShell
            appName="admin"
            rootRoute={Route}
            sidebarMode="collapsible"
            sidebar={({ condensed }) => (
                <AdminSidebar
                    condensed={condensed}
                    teams={teams}
                    isOwner={isOwner}
                    waitlistEnabled={waitlistEnabled}
                    onAddMembersToTeam={handleAddMembersToTeam}
                />
            )}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: AdminRoot,
});
