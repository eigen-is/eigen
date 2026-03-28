import {useNavigate} from '@tanstack/react-router';
import {openDocument} from '@workspace/lib/api';
import {useAuth} from '@workspace/lib/auth';
import {DEFAULT_MOUNT_ID, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {type DrivePath, isDocumentType} from '@workspace/lib/types/drive';
import {useContext} from 'react';
import {useLayout} from '../app/layout-context';
import {NotFound} from '../app/not-found';
import {DriveLayout} from './drive-layout';
import type {EigenDocAppConfig} from './eigendoc-config';
import {EigenDocDriveContext} from './eigendoc-root';

type EigenDocListViewProps = {
    config: EigenDocAppConfig;
    pid?: string;
    mid?: string;
};

export function EigenDocListView({config, pid, mid}: EigenDocListViewProps) {
    const {rootPath} = useContext(EigenDocDriveContext);
    const navigate = useNavigate();
    const {user} = useAuth();
    const ownerId = user!.id;
    const {data: selectedPath = null} = usePathInfo(ownerId, mid || DEFAULT_MOUNT_ID, pid);
    const {isMobile} = useLayout();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useMimeContent(ownerId, config.mimeType);

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
            openDocument(path);
        } else {
            navigate({to: '/', search: {pid: path.id, mid: path.mountId}});
        }
    };

    if (isFolderContentLoadingError) {
        return <NotFound/>;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={folderContents}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={openDocument}
            onBackToList={() => navigate({to: '/'})}
            onAfterAction={() => navigate({to: '/'})}
            allowDelete={true}
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
        />
    );
}
