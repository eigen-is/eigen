// A document app's own index, such as all of the viewer's sheets or the docs on one team drive,
// drawn in Drive's list and detail layout. A row opens its document in the app. The app's index and
// team drive routes render it, and the selection lives in the URL they own.

import { openDocument } from '@workspace/lib/api';
import {
    DEFAULT_MOUNT_ID,
    useAggregateMimeContent,
    useMimeContent,
    useMountMimeContent,
    usePathInfo,
} from '@workspace/lib/drive';
import type { DrivePath, DriveSearchParams } from '@workspace/lib/types/drive';
import { isDocumentType } from '@workspace/lib/types/drive';
import { useContext } from 'react';
import { useLayout } from '../layout/app/layout-context';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';
import { useDriveQuickLook } from './use-drive-quick-look';

type EigenDocListViewProps = {
    config: EigenDocAppConfig;
    viewerId: string;
    pid?: string;
    uid?: string;
    mid?: string;
    ownerId?: string;
    mountId?: string;
    onNavigate: (search: DriveSearchParams) => void;
    onNavigateBack: () => void;
};

export function EigenDocListView({
    config,
    viewerId,
    pid,
    uid,
    mid,
    ownerId,
    mountId,
    onNavigate,
    onNavigateBack,
}: EigenDocListViewProps) {
    const { rootPath } = useContext(EigenDocDriveContext);
    const effectiveOwnerId = ownerId ?? viewerId;
    const isMountScoped = !!mountId;
    const effectiveMountId = mid || mountId || DEFAULT_MOUNT_ID;

    // The default index also lists items others shared with the viewer, so the selected item's owner, the
    // `uid` in the URL, can differ from the list's owner.
    const { data: selectedPath = null } = usePathInfo(uid || effectiveOwnerId, effectiveMountId, pid);
    const { isMobile } = useLayout();
    const capabilities = {
        ...DRIVE_CAPABILITIES.listing,
        // Move to works inside the layout's one owner and mount, so only a list of one mount offers it.
        canMove: isMountScoped,
        createTypes: new Set([config.type]),
    };
    const onQuickLook = useDriveQuickLook(capabilities.canWrite);

    // The viewer's own index gathers their personal drive and all their team drives. Another owner without
    // a mount gets a plain listing of that owner, and a view with a mount lists only that mount.
    const isOwnAggregate = !isMountScoped && effectiveOwnerId === viewerId;
    const aggregate = useAggregateMimeContent(isOwnAggregate ? config.mimeType : '');
    const ownerScoped = useMimeContent(isMountScoped || isOwnAggregate ? '' : effectiveOwnerId, config.mimeType);
    const mountScoped = useMountMimeContent(isMountScoped ? effectiveOwnerId : '', mountId ?? '', config.mimeType);
    const {
        data: folderContents = [],
        isLoading,
        error,
    } = isMountScoped ? mountScoped : isOwnAggregate ? aggregate : ownerScoped;

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
            ownerId={uid || effectiveOwnerId}
            mountId={effectiveMountId}
            folderContents={folderContents}
            isLoading={isLoading}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={openDocument}
            onQuickLook={onQuickLook}
            onBackToList={onNavigateBack}
            onAfterAction={onNavigateBack}
            capabilities={capabilities}
            title={config.allLabel}
            currentPath={rootPath}
        />
    );
}
