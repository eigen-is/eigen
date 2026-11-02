// A document app's own index, such as all of the viewer's sheets or the docs on one team drive,
// drawn in Drive's list and detail layout. A row opens its document in the app. The app's index and
// team drive routes render it, and the selection lives in the URL they own.

import { openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
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
import { EmptyState } from '../layout/app/empty-state';
import { useLayout } from '../layout/app/layout-context';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';
import { useDriveQuickLook } from './use-drive-quick-look';

type EigenDocListViewProps = {
    config: EigenDocAppConfig;
    pid?: string;
    uid?: string;
    mid?: string;
    ownerId?: string;
    mountId?: string;
    // Move to… works inside the layout's one owner and mount, so it is safe only in a list of one mount.
    // The default index spans several mounts and shared items, so moving is off unless a route asks.
    allowMove?: boolean;
    onNavigate: (search: DriveSearchParams) => void;
    onNavigateBack: () => void;
};

export function EigenDocListView({
    config,
    pid,
    uid,
    mid,
    ownerId,
    mountId,
    allowMove = false,
    onNavigate,
    onNavigateBack,
}: EigenDocListViewProps) {
    const { rootPath } = useContext(EigenDocDriveContext);
    const { user } = useAuth();
    const effectiveOwnerId = ownerId || user!.id;
    const isMountScoped = !!mountId;
    const effectiveMountId = mid || mountId || DEFAULT_MOUNT_ID;

    // The default index also lists items others shared with the viewer, so the selected item's owner, the
    // `uid` in the URL, can differ from the list's owner.
    const { data: selectedPath = null } = usePathInfo(uid || effectiveOwnerId, effectiveMountId, pid);
    const { isMobile } = useLayout();
    const capabilities = {
        ...DRIVE_CAPABILITIES.listing,
        canMove: allowMove,
        createTypes: new Set([config.type]),
    };
    const onQuickLook = useDriveQuickLook(capabilities.canWrite);

    // The viewer's own index gathers their personal drive and all their team drives. Another owner without
    // a mount gets a plain listing of that owner, and a view with a mount lists only that mount.
    const isOwnAggregate = !isMountScoped && effectiveOwnerId === user!.id;
    const aggregate = useAggregateMimeContent(isOwnAggregate ? config.mimeType : '');
    const ownerScoped = useMimeContent(isMountScoped || isOwnAggregate ? '' : effectiveOwnerId, config.mimeType);
    const mountScoped = useMountMimeContent(isMountScoped ? effectiveOwnerId : '', mountId || '', config.mimeType);
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

    if (error) {
        return <EmptyState message="Encountering the null vector: a rendezvous with nothing at all." />;
    }

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
            emptyState={<EmptyState hint={`Use the “${config.newLabel}” button to create one.`} />}
        />
    );
}
