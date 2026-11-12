// Drive's Shared by me and Shared with me pages: one flat listing of the items the viewer shares or is
// shared, laid out by DriveLayout. Items shared with the viewer belong to other people, so the page
// offers nothing that writes there, and a delete leaves the share.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { usePathInfo, useSharedPaths, validateDriveSearch } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';

export const Route = createFileRoute('/_auth/shared/$to')({
    component: SharedRoute,
    validateSearch: validateDriveSearch,
});

function SharedRoute() {
    const { to } = Route.useParams();
    const navigate = useNavigate();
    const { uid, pid, mid } = Route.useSearch();
    const { user } = Route.useRouteContext();
    const ownerId = user.id;
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid);

    const {
        data: folderContents = [],
        isLoading,
        error,
    } = useSharedPaths(ownerId, to === 'by-me' ? 'by-me' : 'with-me');

    // The with-me feed says nothing about the viewer's access to each row, so only the by-me side writes.
    // Delete stays on both sides: on the with-me side it leaves the share.
    const capabilities: DriveCapabilities = {
        ...DRIVE_CAPABILITIES.listing,
        canRename: to === 'by-me',
        canWrite: to === 'by-me',
    };

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: folderContents,
        capabilities,
        onOpenFolder: (path: DrivePath) =>
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            }),
        onSelectItem: (path: DrivePath) =>
            navigate({
                to: Route.fullPath,
                params: { to },
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            }),
    });

    const handleBackToList = () => {
        navigate({ to: Route.fullPath, params: { to } });
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
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            capabilities={capabilities}
            title={to === 'by-me' ? 'Shared by me' : 'Shared with me'}
            onQuickLook={onQuickLook}
        />
    );
}
