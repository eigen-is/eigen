import {useNavigate} from '@tanstack/react-router';
import {openDocument} from '@workspace/lib/api';
import {useAuth} from '@workspace/lib/auth';
import {DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths} from '@workspace/lib/drive';
import {type DrivePath, type DriveSearchParams, isDocumentType} from '@workspace/lib/types/drive';
import {useContext} from 'react';
import {useLayout} from '../app/layout-context';
import {LoadingState} from '../app/loading-state';
import {NotFound} from '../app/not-found';
import {DriveLayout} from './drive-layout';
import type {EigenDocAppConfig} from './eigendoc-config';
import {EigenDocDriveContext} from './eigendoc-root';

type EigenDocSharedViewProps = {
    config: EigenDocAppConfig;
    to: string;
    pid?: string;
    uid?: string;
    mid?: string;
    onNavigate: (search: DriveSearchParams) => void;
    onNavigateBack: () => void;
};

export function EigenDocSharedView({config, to, pid, uid, mid, onNavigate, onNavigateBack}: EigenDocSharedViewProps) {
    const {rootPath} = useContext(EigenDocDriveContext);
    const navigate = useNavigate();
    const {user} = useAuth();
    const ownerId = user!.id;
    const {data: selectedPath = null} = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');
    const {isMobile} = useLayout();

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
            onNavigate({pid: path.id, uid: path.ownerId, mid: path.mountId});
        }
    };

    if (isFolderContentLoadingError) {
        return <NotFound/>;
    }

    if (isFolderContentLoading) {
        return <LoadingState/>;
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
            onAfterAction={() => navigate({to: '/'})}
            allowDelete={to === 'by-me'}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={config.driveType === 'doc'}
            allowCreateStickies={config.driveType === 'stickies'}
            allowCreateChat={false}
            allowCreateSlides={config.driveType === 'slides'}
            allowCreateSheets={config.driveType === 'sheets'}
            showBreadcrumb={false}
            currentPath={rootPath}
            allowRename={to === 'by-me'}
        />
    );
}
