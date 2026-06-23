import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths, useUserWatches } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import {
    type DrivePath,
    type DriveSearchParams,
    type EigenDocType,
    isDocumentType,
    isFolderType,
    isInlineEditable,
} from '@workspace/lib/types/drive';
import { LoadingState } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
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

    const { data: myTeams, isLoading: isTeamsLoading } = useMyTeams();
    const teams = myTeams?.map((t) => teamOwnerId(t.id)) ?? [];

    // Watches on alice's share live in alice's mount; include her ownerId so those watches
    // are fetched. Wait for the share list so the owner set is complete on the first fetch.
    const { data: sharedWithMe, isLoading: isSharedLoading } = useSharedPaths(userId, 'with-me');
    const ownerIds = isSharedLoading
        ? []
        : [...new Set([userId, ...teams, ...(sharedWithMe?.map((p) => p.ownerId) ?? [])])];

    const watches = useUserWatches(ownerIds);
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

    if (isTeamsLoading || isSharedLoading) return <LoadingState />;

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
            allowDelete={false}
            allowShare={false}
            allowCreateFolder={false}
            allowUpload={false}
            allowMove={false}
            allowRename={false}
            showBreadcrumb={false}
            title="Watched"
            allowedCreateTypes={new Set<EigenDocType>()}
            onQuickLook={onQuickLook}
            getItemHref={getDriveItemUrl}
        />
    );
}
