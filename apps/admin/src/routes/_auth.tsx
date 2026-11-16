// The admin app's signed-in area. The shared guard sends a signed-out visitor to /login and hands the user
// to every child route's context. The page then makes the instance's organization active and shows the admin
// pages only to its admins and owners, hiding the sidebar from anyone else.

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useMembers } from '@workspace/lib/admin';
import { authClient } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { EmptyState, LoadingState, useLayout } from '@workspace/ui/components/layout/app';
import { createAuthRouteOptions } from '@workspace/ui/components/layout/pages';
import { useEffect, useRef } from 'react';

export const Route = createFileRoute('/_auth')({
    ...createAuthRouteOptions(),
    component: AuthGuard,
});

function AuthGuard() {
    const { user } = Route.useRouteContext();
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
    const currentMember = members?.find((m) => m.userId === user.id);
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
