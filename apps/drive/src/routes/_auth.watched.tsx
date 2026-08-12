import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useAllWatches, usePathInfo } from '@workspace/lib/drive';
import {
    type DrivePath,
    type DriveSearchParams,
    isDocumentType,
    isFolderType,
    isInlineEditable,
} from '@workspace/lib/types/drive';
import { LoadingState } from '@workspace/ui';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/layout/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/layout/drive/drive-layout';
import { usePreview } from '@workspace/ui/components/layout/preview-provider';

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
    const { isMobile } = useLayout();
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();

    // One request fans out server-side over the caller's own home, their teams, and every owner
    // who shared a path with them (?all=1).
    const { data: watches = [], isLoading } = useAllWatches();
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            });
        }
    };

    const onQuickLook = (path: DrivePath, sortedSiblings: DrivePath[]) => {
        openPreview(path, sortedSiblings);
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            });
        } else if (isDocumentType(path.type)) {
            openDocument(path);
        } else if (isInlineEditable(path.mimeType, path.name)) {
            navigate({
                to: '/edit/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            });
        } else {
            openPreview(path, watches);
        }
    };

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
