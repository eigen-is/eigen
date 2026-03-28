import { Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useRootFolder } from '@workspace/lib/drive';
import type { DriveContextType } from '@workspace/lib/types/drive';
import { createContext } from 'react';
import { AppShell } from '../app/app-shell';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocSidebar } from './eigendoc-sidebar';

export const EigenDocDriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID,
});

type EigenDocRootProps = {
    config: EigenDocAppConfig;
    rootRoute: { useNavigate: () => (opts: { to: string }) => unknown };
    isFullScreen?: boolean;
};

export function EigenDocRoot({ config, rootRoute, isFullScreen = false }: EigenDocRootProps) {
    const { user } = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const { data: root } = useRootFolder(user?.id || '', mountId);
    const rootPath = root || null;

    if (!user) {
        return (
            <AppShell appName={config.appName} rootRoute={rootRoute}>
                <Outlet />
            </AppShell>
        );
    }

    return (
        <AppShell
            appName={config.appName}
            rootRoute={rootRoute}
            sidebarMode={isFullScreen ? 'none' : 'collapsible'}
            sidebar={
                !isFullScreen
                    ? ({ condensed, isMobile, onClose }) => (
                          <EigenDocSidebar
                              config={config}
                              condensed={condensed}
                              isMobile={isMobile}
                              onClose={onClose}
                              rootPath={rootPath}
                          />
                      )
                    : undefined
            }
        >
            <EigenDocDriveContext.Provider value={{ rootPath, mountId }}>
                <Outlet />
            </EigenDocDriveContext.Provider>
        </AppShell>
    );
}
