import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths } from '@workspace/lib/drive';
import {
    type DrivePath,
    type DriveSearchParams,
    isDocumentType,
    isFolderType,
    isInlineEditable,
} from '@workspace/lib/types/drive';
import { LoadingState, NotFound } from '@workspace/ui';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/layout/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/layout/drive/drive-layout';
import { usePreview } from '@workspace/ui/components/layout/preview-provider';

export const Route = createFileRoute('/_auth/shared/$to')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return { pid, uid, mid } as DriveSearchParams;
    },
});

function DriveRoute() {
    const { to } = Route.useParams();
    const navigate = useNavigate();
    const { uid, pid, mid } = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const { data: selectedPath = null } = usePathInfo(uid || '', mid || DEFAULT_MOUNT_ID, pid || '');
    const { isMobile } = useLayout();
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useSharedPaths(ownerId, to as 'by-me' | 'with-me');

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                params: { to },
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
            openPreview(path, folderContents);
        }
    };

    const handleBackToList = () => {
        navigate({ to: Route.fullPath, params: { to } });
    };

    if (isFolderContentLoadingError) {
        return <NotFound />;
    }

    if (isFolderContentLoading) {
        return <LoadingState />;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={folderContents ?? []}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => {}}
            capabilities={{
                ...DRIVE_CAPABILITIES.listing,
                canDelete: to === 'by-me',
                canRename: to === 'by-me',
            }}
            title={to === 'by-me' ? 'Shared by me' : 'Shared with me'}
            onQuickLook={onQuickLook}
            getItemHref={getDriveItemUrl}
            emptyState={
                <EmptyState
                    message={
                        to === 'by-me'
                            ? 'Files you’ve shared will appear here.'
                            : 'Files shared with you will appear here.'
                    }
                />
            }
        />
    );
}
