import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useAllWatches, usePathInfo } from '@workspace/lib/drive';
import type { DrivePath, DriveSearchParams } from '@workspace/lib/types/drive';
import { EmptyState, LoadingState } from '@workspace/ui';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';

export const Route = createFileRoute('/_auth/watched')({
    component: WatchedRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return { pid, uid, mid };
    },
});

function WatchedRoute() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const userId = user!.id;
    const { pid, uid, mid } = Route.useSearch();

    // One request fans out server-side over the caller's own home, their teams, and every owner
    // who shared a path with them (?all=1).
    const { data: watches = [], isLoading } = useAllWatches();
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: watches,
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

    if (isLoading) return <LoadingState />;

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || userId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={watches}
            isLoading={false}
            error={null}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBack}
            onAfterAction={() => {}}
            capabilities={DRIVE_CAPABILITIES.readOnly}
            title="Watched"
            onQuickLook={onQuickLook}
            getItemHref={getDriveItemUrl}
            emptyState={<EmptyState message="Watched files will appear here." />}
        />
    );
}
