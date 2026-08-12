import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    DEFAULT_MOUNT_ID,
    useAggregateMimeContent,
    useMimeContent,
    useMountMimeContent,
    usePathInfo,
} from '@workspace/lib/drive';
import { type DrivePath, type DriveSearchParams, isDocumentType } from '@workspace/lib/types/drive';
import { useContext } from 'react';
import { EmptyState } from '../app/empty-state';
import { useLayout } from '../app/layout-context';
import { usePreview } from '../preview-provider';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';

type EigenDocListViewProps = {
    config: EigenDocAppConfig;
    pid?: string;
    uid?: string;
    mid?: string;
    ownerId?: string;
    mountId?: string;
    // Move-to/duplicate bind to the layout's single ownerId/mountId, so they're only
    // safe in the mount-scoped variant where every item shares them. The owner-aggregate
    // index spans mounts + shared paths, so it defaults off.
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

    // The owner-aggregated mime query can return paths owned by other users via sharedPaths,
    // so the selected item's owner (uid from search) may differ from the list's ownerId.
    const { data: selectedPath = null } = usePathInfo(uid || effectiveOwnerId, effectiveMountId, pid);
    const { isMobile } = useLayout();
    const { openPreview } = usePreview();

    // Own aggregate (personal + all my team mounts) is the default index; an explicit foreign owner
    // (no mount) stays a plain per-owner listing, and a mount-scoped view stays single-mount.
    const isOwnAggregate = !isMountScoped && effectiveOwnerId === user!.id;
    const aggregate = useAggregateMimeContent(isOwnAggregate ? config.mimeType : '');
    const ownerScoped = useMimeContent(isMountScoped || isOwnAggregate ? '' : effectiveOwnerId, config.mimeType);
    const mountScoped = useMountMimeContent(isMountScoped ? effectiveOwnerId : '', mountId || '', config.mimeType);
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = isMountScoped ? mountScoped : isOwnAggregate ? aggregate : ownerScoped;

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

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || effectiveOwnerId}
            mountId={effectiveMountId}
            folderContents={folderContents}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={openDocument}
            onQuickLook={(path, siblings) => openPreview(path, siblings)}
            onBackToList={onNavigateBack}
            onAfterAction={onNavigateBack}
            capabilities={{
                ...DRIVE_CAPABILITIES.listing,
                canMove: allowMove,
                createTypes: new Set([config.createType]),
            }}
            getItemHref={getDriveItemUrl}
            title={config.allLabel}
            currentPath={rootPath}
            emptyState={<EmptyState hint={`Use the “${config.newLabel}” button to create one.`} />}
        />
    );
}
