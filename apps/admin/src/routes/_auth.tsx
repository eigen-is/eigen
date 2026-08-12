import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useMembers } from '@workspace/lib/admin';
import { authClient, useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { EmptyState, LoadingState } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { useEffect, useRef } from 'react';

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({ context, location }) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: {
                    redirect: location.href,
                },
            });
        }
    },
    component: AuthGuard,
});

function AuthGuard() {
    const { user } = useAuth();
    const { data: config, isLoading: configLoading } = usePublicConfig();
    const { data: members, isLoading: membersLoading } = useMembers(config?.orgId);
    const { setSidebarHidden } = useLayout();
    const activatedRef = useRef(false);

    useEffect(() => {
        if (config?.orgId && !activatedRef.current) {
            activatedRef.current = true;
            authClient.organization.setActive({ organizationId: config.orgId });
        }
    }, [config]);

    const isLoading = configLoading || membersLoading;
    const currentMember = members?.find((m) => m.userId === user?.id);
    const isAdmin = currentMember?.role === 'admin' || currentMember?.role === 'owner';

    useEffect(() => {
        if (!isLoading) setSidebarHidden(!isAdmin);
        return () => setSidebarHidden(false);
    }, [isLoading, isAdmin, setSidebarHidden]);

    if (isLoading) {
        return <LoadingState />;
    }

    if (!config?.orgId) {
        return <EmptyState message="No organization found." />;
    }

    if (!isAdmin) {
        return <EmptyState message="You need admin or owner privileges to access this page." />;
    }

    return <Outlet />;
}
