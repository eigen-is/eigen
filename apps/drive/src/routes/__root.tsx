// Drive's root route: the app shell around every Drive page. A signed-in user gets the sidebar with the New
// menu and their personal root folder, shared with the pages through DriveContext. A guest gets the sidebar
// without a root folder, and a signed-out visitor only the shell.

import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useRootFolder } from '@workspace/lib/drive';
import type { AuthUser, RouterAppContext } from '@workspace/lib/types/auth';
import type { DriveContextType } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { AppShell, ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { AppSidebar } from '@workspace/ui/components/layout/sidebar';
import { createContext } from 'react';
import { DriveNewMenu } from '../components/drive/drive-new-menu';

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
});

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: DriveRoot,
});

function DriveRoot() {
    const { user } = useAuth();
    const isGuest = useIsGuest();

    if (user && !isGuest) return <AuthenticatedDriveRoot user={user} />;

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

function AuthenticatedDriveRoot({ user }: { user: AuthUser }) {
    const { data: root, isLoading, error } = useRootFolder(user.id, DEFAULT_MOUNT_ID);
    const rootPath = root ?? null;

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
