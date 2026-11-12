// A document app's own index, such as all of the viewer's sheets or the docs on one team drive,
// drawn in Drive's list and detail layout. A row opens its document in the app. An app's routes, such as
// its index, render it and hand over themselves, so the view reads its params, the selection and the
// viewer from that route, and a selected row goes into its URL.

import { openDocument } from '@workspace/lib/api';
import type { validateDriveSearch } from '@workspace/lib/drive';
import { DEFAULT_MOUNT_ID, useAggregateMimeContent, useMountMimeContent, usePathInfo } from '@workspace/lib/drive';
import type { DrivePath, DriveSearchParams } from '@workspace/lib/types/drive';
import { isDocumentType } from '@workspace/lib/types/drive';
import { useContext } from 'react';
import { useLayout } from '../layout/app/layout-context';
import { DRIVE_CAPABILITIES } from './drive-capabilities';
import { DriveLayout } from './drive-layout';
import type { EigenDocAppConfig } from './eigendoc-config';
import { EigenDocDriveContext } from './eigendoc-root';
import { useDriveQuickLook } from './use-drive-quick-look';

// The app route that renders a view, typed by its shape because each app has its own route tree. `types`
// holds TanStack's type-only fields, so a route whose search skips validateDriveSearch fails to compile.
// Its navigate stays on the route and its params, so it changes only the search.
export type EigenDocListRoute<TParams> = {
    types: { searchValidator: typeof validateDriveSearch };
    useParams: () => TParams;
    useSearch: () => DriveSearchParams;
    useRouteContext: () => { user: { id: string } };
    useNavigate: () => (options: { search?: DriveSearchParams }) => Promise<void>;
};

type EigenDocListViewProps = {
    config: EigenDocAppConfig;
    // The index names no drive, and a team drive's route names both its owner and its mount.
    route: EigenDocListRoute<{ ownerId?: undefined; mountId?: undefined } | { ownerId: string; mountId: string }>;
};

export function EigenDocListView({ config, route }: EigenDocListViewProps) {
    const { ownerId, mountId } = route.useParams();
    const { pid, uid, mid } = route.useSearch();
    const viewerId = route.useRouteContext().user.id;
    const navigate = route.useNavigate();
    const clearSelection = () => navigate({});
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
        // The other lists also hold items shared with the viewer, whose drive the move picker can't open.
        canMove: isMountScoped,
        createTypes: new Set([config.type]),
    };
    const onQuickLook = useDriveQuickLook(capabilities.canWrite);

    // The index gathers the viewer's personal drive and all their team drives; a team drive lists only its mount.
    const aggregate = useAggregateMimeContent(isMountScoped ? '' : config.mimeType);
    const mountScoped = useMountMimeContent(ownerId ?? '', mountId ?? '', config.mimeType);
    const { data: folderContents = [], isLoading, error } = isMountScoped ? mountScoped : aggregate;

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
            openDocument(path);
        } else {
            navigate({ search: { pid: path.id, uid: path.ownerId, mid: path.mountId } });
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
            onBackToList={clearSelection}
            onAfterAction={clearSelection}
            capabilities={capabilities}
            title={config.allLabel}
            currentPath={rootPath}
        />
    );
}
