// A document app's Shared by me or Shared with me list, such as the slides shared with the viewer: Drive's
// shared listing narrowed to the app's type, drawn in Drive's list and detail layout. A row opens its
// document in the app. The app's shared route renders it.

import { useNavigate } from '@tanstack/react-router';
import { openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths } from '@workspace/lib/drive';
import type { DrivePath, DriveSearchParams } from '@workspace/lib/types/drive';
import { isDocumentType } from '@workspace/lib/types/drive';
import { useContext } from 'react';
import { useLayout } from '../layout/app/layout-context';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { eigenDocSharedTitle } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';
import { useDriveQuickLook } from './use-drive-quick-look';

type EigenDocSharedViewProps = {
    config: EigenDocAppConfig;
    to: string;
    pid?: string;
    uid?: string;
    mid?: string;
    onNavigate: (search: DriveSearchParams) => void;
    onNavigateBack: () => void;
};

export function EigenDocSharedView({ config, to, pid, uid, mid, onNavigate, onNavigateBack }: EigenDocSharedViewProps) {
    const { rootPath } = useContext(EigenDocDriveContext);
    const navigate = useNavigate();
    const { user } = useAuth();
    const ownerId = user!.id;
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');
    const { isMobile } = useLayout();
    // As in Drive's shared view, a row shared with the viewer belongs to someone else, and this listing
    // doesn't say what access the viewer has. So only the by-me side offers rows that write.
    const canWrite = to === 'by-me';
    const onQuickLook = useDriveQuickLook(canWrite);

    const {
        data: unfilteredFolderContents = [],
        isLoading,
        error,
    } = useSharedPaths(ownerId, to === 'by-me' ? 'by-me' : 'with-me');

    const folderContents = unfilteredFolderContents.filter((path) => path.type === config.type);

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
            openDocument(path);
        } else {
            onNavigate({ pid: path.id, uid: path.ownerId, mid: path.mountId });
        }
    };

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={folderContents}
            isLoading={isLoading}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={openDocument}
            onQuickLook={onQuickLook}
            onBackToList={onNavigateBack}
            onAfterAction={() => navigate({ to: '/' })}
            capabilities={{
                ...DRIVE_CAPABILITIES.listing,
                canRename: canWrite,
                canWrite,
                createTypes: new Set([config.type]),
            }}
            title={eigenDocSharedTitle(to === 'by-me' ? 'by' : 'with', config.labelPlural)}
            currentPath={rootPath}
        />
    );
}
