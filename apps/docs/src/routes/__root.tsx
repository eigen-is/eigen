import {createRootRouteWithContext, Outlet, useMatch} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {DocsSidebar} from "../components/docs/docs-sidebar";
import {DEFAULT_MOUNT_ID, useRootFolder} from '@workspace/lib/drive';
import {createContext} from 'react';
import {DriveContextType} from '@workspace/lib/types/drive';

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID
});

type MyRouterContext = {
    auth: AuthContextType
}

function DocsRoot() {
    const {user} = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const {data: root} = useRootFolder(user?.id || '', mountId);
    const rootPath = root || null;

    const isEditorRoute = useMatch({
        from: '/_auth/doc/$ownerId/$mountId/$pathId',
        shouldThrow: false,
    });

    const isFullScreen = !!isEditorRoute;

    if (!user) {
        return (
            <AppShell appName="docs" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="docs"
            rootRoute={Route}
            sidebarMode={isFullScreen ? 'none' : 'collapsible'}
            sidebar={!isFullScreen ? ({condensed, isMobile, onClose}) => (
                <DocsSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    rootPath={rootPath}
                />
            ) : undefined}
        >
            <DriveContext.Provider value={{rootPath, mountId}}>
                <Outlet/>
            </DriveContext.Provider>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: DocsRoot,
});
