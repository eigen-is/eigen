import { useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths } from '@workspace/lib/drive';
import { type DrivePath, type DriveSearchParams, isDocumentType } from '@workspace/lib/types/drive';
import { useContext } from 'react';
import { EmptyState } from '../layout/app/empty-state';
import { useLayout } from '../layout/app/layout-context';
import { LoadingState } from '../layout/app/loading-state';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';

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

    const {
        data: unfilteredFolderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useSharedPaths(ownerId, to as 'by-me' | 'with-me');

    const folderContents = unfilteredFolderContents?.filter((path) => path.type === config.driveType) || [];

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
            openDocument(path);
        } else {
            onNavigate({ pid: path.id, uid: path.ownerId, mid: path.mountId });
        }
    };

    if (isFolderContentLoadingError) {
        return <EmptyState message="Encountering the null vector: a rendezvous with nothing at all." />;
    }

    if (isFolderContentLoading) {
        return <LoadingState />;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={folderContents ?? []}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={openDocument}
            onBackToList={onNavigateBack}
            onAfterAction={() => navigate({ to: '/' })}
            capabilities={{
                ...DRIVE_CAPABILITIES.listing,
                canDelete: to === 'by-me',
                canRename: to === 'by-me',
                createTypes: new Set([config.createType]),
            }}
            getItemHref={getDriveItemUrl}
            title={`${config.labelPlural} shared ${to === 'by-me' ? 'by' : 'with'} me`}
            currentPath={rootPath}
            emptyState={
                <EmptyState
                    message={
                        to === 'by-me'
                            ? `${config.labelPlural} you’ve shared will appear here.`
                            : `${config.labelPlural} shared with you will appear here.`
                    }
                />
            }
        />
    );
}
