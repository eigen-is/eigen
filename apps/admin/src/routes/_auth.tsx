import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useMembers } from '@workspace/lib/admin';
import { authClient, useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { AccessDenied, EmptyState, LoadingState } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { useEffect, useRef, useState } from 'react';

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
    const [orgReady, setOrgReady] = useState(false);
    const activatedRef = useRef(false);
    const { setSidebarHidden } = useLayout();

    // setActive must complete before listMembers will return correct data,
    // because the session needs activeOrganizationId to be set server-side
    useEffect(() => {
        if (config?.orgId && !activatedRef.current) {
            activatedRef.current = true;
            authClient.organization
                .setActive({ organizationId: config.orgId })
                .then(() => setOrgReady(true))
                .catch(() => setOrgReady(true));
        }
    }, [config]);

    const { data: members, isLoading: membersLoading } = useMembers(orgReady ? config?.orgId : undefined);

    const currentMember = members?.find((m) => m.userId === user?.id);
    const isAdmin = currentMember?.role === 'admin' || currentMember?.role === 'owner';

    useEffect(() => {
        setSidebarHidden(!isAdmin);
        return () => setSidebarHidden(false);
    }, [isAdmin, setSidebarHidden]);

    if (configLoading || !orgReady || membersLoading) {
        return <LoadingState />;
    }

    if (!config?.orgId) {
        return <EmptyState message="No organization found." />;
    }

    if (!isAdmin) {
        return <AccessDenied message="You need admin or owner privileges to access this page." />;
    }

    return <Outlet />;
}
