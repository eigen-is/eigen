// The shell of a document app, such as Docs or Slides: the sidebar with the app's New button, and the root folder
// its pages create in, shared through EigenDocDriveContext. On a team drive's route that is the team drive's root,
// else the viewer's own; a guest has none. Each app's root route renders it.

import { Outlet } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useRootFolder } from '@workspace/lib/drive';
import type { DriveContextType } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { createContext } from 'react';
import { AppShell } from '../layout/app/app-shell';
import { AppSidebar } from '../layout/sidebar/app-sidebar';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocNewButton } from './eigendoc-new-button';

export const EigenDocDriveContext = createContext<DriveContextType>({
    rootPath: null,
});

type EigenDocRootProps = {
    config: EigenDocAppConfig;
    rootRoute: { useNavigate: () => (opts: { to: string }) => unknown };
    isFullScreen?: boolean;
    teamOwnerId?: string;
    teamMountId?: string;
};

export function EigenDocRoot({ config, rootRoute, isFullScreen = false, teamOwnerId, teamMountId }: EigenDocRootProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const isTeamView = !!teamOwnerId && !!teamMountId && parseOwnerId(teamOwnerId).type === 'team';
    const activeOwnerId = isTeamView ? teamOwnerId : isGuest ? '' : user?.id || '';
    const activeMountId = isTeamView ? teamMountId : DEFAULT_MOUNT_ID;
    const { data: root } = useRootFolder(activeOwnerId, activeMountId);
    const rootPath = isGuest ? null : root || null;

    return (
        <AppShell
            appName={config.appName}
            rootRoute={rootRoute}
            sidebarMode={isFullScreen ? 'none' : 'collapsible'}
            sidebar={
                user && !isFullScreen
                    ? ({ condensed }) => (
                          <AppSidebar
                              condensed={condensed}
                              newButton={
                                  isGuest ? undefined : (
                                      <EigenDocNewButton config={config} rootPath={rootPath} condensed={condensed} />
                                  )
                              }
                          />
                      )
                    : undefined
            }
        >
            {user ? (
                <EigenDocDriveContext.Provider value={{ rootPath }}>
                    <Outlet />
                </EigenDocDriveContext.Provider>
            ) : (
                <Outlet />
            )}
        </AppShell>
    );
}
