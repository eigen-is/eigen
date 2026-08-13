import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth, useIsGuest } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useRootFolder } from '@workspace/lib/drive';
import type { DriveContextType } from '@workspace/lib/types/drive';
import { ErrorState, LoadingState } from '@workspace/ui';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
import { AppSidebar } from '@workspace/ui/components/layout/sidebar/app-sidebar';
import { createContext } from 'react';
import { DriveNewMenu } from '../components/drive/drive-new-menu';

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
});

function DriveRoot() {
    const { user } = useAuth();
    const isGuest = useIsGuest();

    if (user && !isGuest) return <AuthenticatedDriveRoot />;

    // Signed-out and guest share one shell: a guest gets the sidebar and a null-root
    // DriveContext, a signed-out visitor gets neither.
    return (
        <AppShell
            appName="drive"
            rootRoute={Route}
            sidebar={user ? ({ condensed }) => <AppSidebar condensed={condensed} /> : undefined}
        >
            {user ? (
                <DriveContext.Provider value={{ rootPath: null }}>
                    <Outlet />
                </DriveContext.Provider>
            ) : (
                <Outlet />
            )}
        </AppShell>
    );
}

function AuthenticatedDriveRoot() {
    const { user } = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const { data: root, isLoading, error } = useRootFolder(user!.id, mountId);
    const rootPath = root || null;

    if (isLoading) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <LoadingState />
            </AppShell>
        );
    }

    if (error) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <ErrorState message="Error loading drive content" detail={error.message} />
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="drive"
            rootRoute={Route}
            sidebar={({ condensed }) => (
                <AppSidebar
                    condensed={condensed}
                    newButton={<DriveNewMenu rootPath={rootPath} condensed={condensed} />}
                />
            )}
        >
            <DriveContext.Provider value={{ rootPath }}>
                <Outlet />
            </DriveContext.Provider>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: DriveRoot,
});
