import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth } from '@workspace/lib/auth';
import { useUnreadChatIds } from '@workspace/lib/chat';
import { useFolderContent, usePathInfo } from '@workspace/lib/drive';
import {
    type DrivePath,
    type DriveSearchParams,
    isDocumentType,
    isFolderType,
    isInlineEditable,
} from '@workspace/lib/types/drive';
import { LoadingState, NotFound, RequestAccessView } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/layout/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/layout/drive/drive-layout';
import { usePreview } from '@workspace/ui/components/layout/preview-provider';
import { useContext, useEffect } from 'react';
import { DriveContext } from './__root';

export const Route = createFileRoute('/_auth/fs/$ownerId/$mountId/$pathId')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const sharePathId = typeof search.sharePathId === 'string' ? search.sharePathId : undefined;
        const shareEmail = typeof search.shareEmail === 'string' ? search.shareEmail : undefined;
        const showHistory = search.showHistory === '1' || search.showHistory === true;
        return { pid, uid, sharePathId, shareEmail, showHistory };
    },
});

function DriveRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { pid, sharePathId, shareEmail, showHistory } = Route.useSearch();
    const navigate = useNavigate();
    const { isMobile } = useLayout();
    const { rootPath } = useContext(DriveContext);
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();
    const { user } = useAuth();
    const unreadChatIds = useUnreadChatIds(user?.id ?? '');

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootPath) {
            navigate({
                to: Route.fullPath,
                params: { ownerId: rootPath.ownerId, mountId: rootPath.mountId, pathId: rootPath.id },
            });
        }
    }, [pathId, rootPath, navigate, ownerId]);

    // Don't fetch data until we have the actual root folder ID (not "root")
    const skipDataFetch = pathId === 'root';

    // Fetch folder content and path information
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useFolderContent(ownerId, mountId, skipDataFetch ? '' : pathId);
    const { data: selectedPath = null } = usePathInfo(ownerId, mountId, pid);
    const { data: currentPath = null } = usePathInfo(ownerId, mountId, pathId);
    const { data: shareTargetPath = null } = usePathInfo(ownerId, mountId, sharePathId || '');
    const shareDialogOpen = !!sharePathId && !!shareTargetPath;

    const handleShareDialogClose = (open: boolean) => {
        if (!open) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: { pid, sharePathId: undefined, shareEmail: undefined },
            });
        }
    };

    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else if (currentPath?.parentId === path.id) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId: path.id },
                search: { pid: undefined },
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: { pid: path.id },
            });
        }
    };

    const onQuickLook = (path: DrivePath, sortedSiblings: DrivePath[]) => {
        openPreview(path, sortedSiblings);
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId: path.id },
                search: { pid: undefined },
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

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: { pid: undefined },
        });
    };

    // Callback called by DriveLayout after actions
    const handleAfterAction = (actionType: string, data: Record<string, unknown>) => {
        // Navigate away from deleted item if it was selected
        if (actionType === 'delete' && pid === data.id) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId: pathId },
                search: { pid: undefined },
            });
        }
    };

    // Show loading state while resolving root folder ID
    if (pathId === 'root' && !rootPath) {
        return <LoadingState />;
    }

    if (isFolderContentLoadingError) {
        if (isFolderContentLoadingError instanceof AppError && isFolderContentLoadingError.status === 403) {
            return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
        }
        return <NotFound />;
    }

    return (
        <>
            <DriveLayout
                ownerId={ownerId}
                mountId={mountId}
                pathId={pathId}
                folderContents={folderContents}
                isLoading={isFolderContentLoading}
                error={isFolderContentLoadingError}
                selectedPath={selectedPath}
                currentPath={currentPath}
                onRowSelect={onRowSelect}
                onRowActivate={onRowActivate}
                onBackToList={handleBackToList}
                onAfterAction={handleAfterAction}
                capabilities={DRIVE_CAPABILITIES.browse}
                onQuickLook={onQuickLook}
                getItemHref={getDriveItemUrl}
                pid={pid}
                unreadPathIds={unreadChatIds}
                highlightHistory={showHistory}
            />
            {shareTargetPath && (
                <DriveAccessDialog
                    open={shareDialogOpen}
                    onOpenChange={handleShareDialogClose}
                    path={shareTargetPath}
                    prefillEmail={shareEmail}
                />
            )}
        </>
    );
}
