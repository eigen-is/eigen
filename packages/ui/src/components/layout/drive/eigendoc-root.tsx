import { Outlet, useLocation } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useRootFolder } from '@workspace/lib/drive';
import type { DriveContextType } from '@workspace/lib/types/drive';
import { createContext } from 'react';
import { AppShell } from '../app/app-shell';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocSidebar, GuestEigenDocSidebar } from './eigendoc-sidebar';

export const EigenDocDriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID,
});

type EigenDocRootProps = {
    config: EigenDocAppConfig;
    rootRoute: { useNavigate: () => (opts: { to: string }) => unknown };
    isFullScreen?: boolean;
};

const TEAM_DRIVE_URL = /^\/drive\/(team_[^/]+)\/([^/]+)/;

export function EigenDocRoot({ config, rootRoute, isFullScreen = false }: EigenDocRootProps) {
    const { user } = useAuth();
    const isGuest = user?.role === 'guest';
    const { pathname } = useLocation();
    const teamMatch = pathname.match(TEAM_DRIVE_URL);
    const teamOwnerId = teamMatch?.[1] ?? null;
    const teamMountId = teamMatch?.[2] ?? null;
    const activeOwnerId = teamOwnerId || (isGuest ? '' : user?.id || '');
    const activeMountId = teamMountId || DEFAULT_MOUNT_ID;
    const { data: root } = useRootFolder(activeOwnerId, activeMountId);
    const rootPath = isGuest ? null : root || null;

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
                    ? ({ condensed, isMobile, onClose }) =>
                          isGuest ? (
                              <GuestEigenDocSidebar
                                  config={config}
                                  condensed={condensed}
                                  isMobile={isMobile}
                                  onClose={onClose}
                              />
                          ) : (
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
            <EigenDocDriveContext.Provider value={{ rootPath, mountId: activeMountId }}>
                <Outlet />
            </EigenDocDriveContext.Provider>
        </AppShell>
    );
}
