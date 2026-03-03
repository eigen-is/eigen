import {useEffect, useRef} from 'react';
import {createFileRoute, Outlet, redirect} from '@tanstack/react-router';
import {usePeopleMembers} from '@workspace/lib/people';
import {authClient, useAuth, useOrganization} from '@workspace/lib/auth';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';

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
    const {data: org, isLoading: orgLoading} = useOrganization();
    const {data: members = [], isLoading: membersLoading} = usePeopleMembers(org?.id);
    const activatedRef = useRef(false);

    useEffect(() => {
        if (org && !activatedRef.current) {
            activatedRef.current = true;
            authClient.organization.setActive({organizationId: org.id});
        }
    }, [org]);

    if (orgLoading || membersLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    if (!org) {
        return (
            <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground">No organization found.</p>
            </div>
        );
    }

    const currentMember = members.find(m => m.userId === user?.id);

    if (!currentMember || currentMember.role === 'member') {
        return (
            <div className="flex-1 flex items-center justify-center w-full h-full">
                <div className="text-center space-y-2">
                    <p className="text-lg font-medium">Access Denied</p>
                    <p className="text-muted-foreground">You need admin or owner privileges to access People management.</p>
                </div>
            </div>
        );
    }

    return <Outlet/>;
}
