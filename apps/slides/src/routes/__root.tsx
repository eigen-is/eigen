import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';
import {createContext} from 'react';
import {AppShell} from '@workspace/ui/components/layout/app-shell';
import {SlidesSidebar} from '../components/slides-sidebar';
import {useAuth} from '@workspace/lib/auth';
import {useRootFolder} from '@workspace/lib/drive';
import {DEFAULT_MOUNT_ID} from '@workspace/lib/types/mount';
import type {DrivePath} from '@workspace/lib/types/drive';

type MyRouterContext = {
    auth: ReturnType<typeof useAuth>;
};

export const DriveContext = createContext<{
    rootPath: DrivePath | null;
}>({
    rootPath: null,
});

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: RootLayout,
});

function RootLayout() {
    const auth = useAuth();
    const ownerId = auth.user?.id || '';
    const {data: rootPath = null} = useRootFolder(ownerId, DEFAULT_MOUNT_ID);

    return (
        <DriveContext.Provider value={{rootPath}}>
            <AppShell
                appName="Slides"
                rootRoute="/"
                sidebar={(props) => (
                    <SlidesSidebar
                        condensed={props.condensed}
                        onClose={props.onClose}
                        isMobile={props.isMobile}
                        rootPath={rootPath}
                    />
                )}
            >
                <Outlet/>
            </AppShell>
        </DriveContext.Provider>
    );
}
