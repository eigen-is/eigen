// Drive's Recent page: the files and folders the viewer opened or was notified about, wherever they live,
// each once, with the time of that last activity. It opens newest first every time and keeps its own sort,
// because the shared view preference could open it alphabetically. The rows belong to many owners, so the
// page is read-only, and a selected row's ?pid=&uid=&mid= opens its detail beside the list.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { usePathInfo, useRecentPaths, validateDriveSearch } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveSort } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_auth/recent')({
    component: RecentRoute,
    validateSearch: validateDriveSearch,
});

function RecentRoute() {
    const navigate = useNavigate();
    const { user } = Route.useRouteContext();
    const { pid, uid, mid } = Route.useSearch();

    const { data: recentPaths = [], isLoading, error } = useRecentPaths();
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');
    const [sort, setSort] = useState<DriveSort>({ key: 'modified', dir: 'desc' });
    const lastActivity = useMemo(
        () => new Map(recentPaths.map((path) => [path.id, path.lastActivityAt])),
        [recentPaths],
    );

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: recentPaths,
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
            folderContents={recentPaths}
            isLoading={isLoading}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBack}
            capabilities={DRIVE_CAPABILITIES.readOnly}
            title="Recent files"
            onQuickLook={onQuickLook}
            sort={{ value: sort, onChange: setSort }}
            date={{ label: 'Last activity', of: (path) => lastActivity.get(path.id) ?? null }}
        />
    );
}
