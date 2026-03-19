import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {DriveSidebar} from '../components/drive/drive-sidebar';
import {DEFAULT_MOUNT_ID, useRootFolder} from '@workspace/lib/drive';
import {EigenLoader} from '@workspace/ui';
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
                <div className="flex items-center justify-center h-full w-full">
                    <EigenLoader/>
                </div>
            </AppShell>
        );
    }

    if (error) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <div className="flex flex-col items-center justify-center h-full w-full">
                    <p className="text-destructive">Error loading drive content</p>
                    <p className="text-sm">{error.message}</p>
                </div>
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
