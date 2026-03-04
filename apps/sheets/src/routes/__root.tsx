import {createRootRouteWithContext, Outlet, useMatch} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {DEFAULT_MOUNT_ID, useRootFolder} from '@workspace/lib/drive';
import {createContext} from 'react';
import {DriveContextType} from '@workspace/lib/types/drive';
import {SheetsSidebar} from "@/components/sheets-sidebar.tsx";

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
        from: '/_auth/sheet/$ownerId/$mountId/$pathId',
        shouldThrow: false,
    });

    const isFullScreen = !!isEditorRoute;

    if (!user) {
        return (
            <AppShell appName="sheets" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="sheets"
            rootRoute={Route}
            sidebarMode={isFullScreen ? 'none' : 'collapsible'}
            sidebar={!isFullScreen ? ({condensed, isMobile, onClose}) => (
                <SheetsSidebar
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
