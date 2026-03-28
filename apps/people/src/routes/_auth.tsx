import {createFileRoute, Outlet, redirect} from '@tanstack/react-router';
import {authClient, useAuth} from '@workspace/lib/auth';
import {usePeopleMembers} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {AccessDenied, EmptyState, LoadingState} from '@workspace/ui';
import {useEffect, useRef} from 'react';

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({context, location}) => {
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
    const {user} = useAuth();
    const {data: config, isLoading: configLoading} = usePublicConfig();
    const {data: members = [], isLoading: membersLoading} = usePeopleMembers(config?.orgId);
    const activatedRef = useRef(false);

    useEffect(() => {
        if (config?.orgId && !activatedRef.current) {
            activatedRef.current = true;
            authClient.organization.setActive({organizationId: config.orgId});
        }
    }, [config]);

    if (configLoading || membersLoading) {
        return <LoadingState/>;
    }

    if (!config?.orgId) {
        return <EmptyState message="No organization found."/>;
    }

    const currentMember = members.find((m) => m.userId === user?.id);

    if (!currentMember || currentMember.role === 'member') {
        return <AccessDenied message="You need admin or owner privileges to access People management."/>;
    }

    return <Outlet/>;
}
