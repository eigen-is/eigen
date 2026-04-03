import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useMembers } from '@workspace/lib/admin';
import { authClient, useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';
import { AccessDenied, EmptyState, LoadingState } from '@workspace/ui';
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
    const [orgActivated, setOrgActivated] = useState(false);
    const activatedRef = useRef(false);

    useEffect(() => {
        if (config?.orgId && !activatedRef.current) {
            activatedRef.current = true;
            authClient.organization.setActive({ organizationId: config.orgId }).then(() => setOrgActivated(true));
        }
    }, [config]);

    const { data: members = [], isLoading: membersLoading } = useMembers(orgActivated ? config?.orgId : undefined);

    if (configLoading || membersLoading || !orgActivated) {
        return <LoadingState />;
    }

    if (!config?.orgId) {
        return <EmptyState message="No organization found." />;
    }

    const currentMember = members.find((m) => m.userId === user?.id);

    if (!currentMember || currentMember.role === 'member') {
        return <AccessDenied message="You need admin or owner privileges to access this page." />;
    }

    return <Outlet />;
}
