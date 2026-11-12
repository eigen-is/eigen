// Drive's Watched page: every file and folder the viewer watches, wherever it lives, in one list from a
// single request. The rows belong to many owners, so the page is read-only, and a selected row's
// ?pid=&uid=&mid= opens its detail beside the list.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAllWatches, usePathInfo, validateDriveSearch } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';

export const Route = createFileRoute('/_auth/watched')({
    component: WatchedRoute,
    validateSearch: validateDriveSearch,
});

function WatchedRoute() {
    const navigate = useNavigate();
    const { user } = Route.useRouteContext();
    const { pid, uid, mid } = Route.useSearch();

    const { data: watches = [], isLoading, error } = useAllWatches();
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: watches,
        capabilities: DRIVE_CAPABILITIES.readOnly,
        onOpenFolder: (path: DrivePath) =>
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            }),
        onSelectItem: (path: DrivePath) =>
            navigate({
                to: Route.fullPath,
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            }),
    });

    const handleBack = () => {
        navigate({ to: Route.fullPath, search: { pid: undefined, uid: undefined, mid: undefined } });
    };

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || user.id}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={watches}
            isLoading={isLoading}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBack}
            capabilities={DRIVE_CAPABILITIES.readOnly}
            title="Watched"
            onQuickLook={onQuickLook}
        />
    );
}
