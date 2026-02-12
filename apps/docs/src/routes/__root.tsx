import {createRootRouteWithContext, Outlet, useMatch} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {DocsSidebar} from "../components/docs/docs-sidebar";
import {useRootFolder, DEFAULT_MOUNT_ID} from '@workspace/lib/drive';
import {useAuth} from '@workspace/lib/auth';
import {createContext} from 'react';
import {DriveContextType} from '@workspace/lib/types/drive';

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID
});

interface MyRouterContext {
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
