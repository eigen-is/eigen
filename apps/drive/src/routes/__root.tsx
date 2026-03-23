import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {DriveSidebar} from '../components/drive/drive-sidebar';
import {DEFAULT_MOUNT_ID, useRootFolder} from '@workspace/lib/drive';
import {ErrorState, LoadingState} from '@workspace/ui';
import {createContext} from 'react';
import {DriveContextType} from '@workspace/lib/types/drive';

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID
});

interface MyRouterContext {
    auth: AuthContextType
}

function DriveRoot() {
    const {user} = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const {data: root, isLoading, error} = useRootFolder(user?.id || '', mountId);
    const rootPath = root || null;

    if (!user) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    if (isLoading) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <LoadingState/>
            </AppShell>
        );
    }

    if (error) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <ErrorState message="Error loading drive content" detail={error.message}/>
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="drive"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <DriveSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    rootPath={rootPath}
                />
            )}
        >
            <DriveContext.Provider value={{rootPath, mountId}}>
                <Outlet/>
            </DriveContext.Provider>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: DriveRoot,
});
