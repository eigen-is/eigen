// Drive's folder page: the folder the URL names, with the item ?pid= selects open beside the list. It
// resolves the mount's "root" alias, sends a viewer who may open only the selected item to that item's
// share link, offers a request for access when the folder is closed to the viewer, and opens the share
// dialog that ?sharePathId= asks for. A public link opens it without a login, read-only and with no share dialog.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveShareUrl } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth } from '@workspace/lib/auth';
import { useUnreadChatIds } from '@workspace/lib/chat';
import {
    useCanWriteFolder,
    useFolderContent,
    usePathInfo,
    useWritesByName,
    validateDriveSearch,
} from '@workspace/lib/drive';
import type { DriveSearchParams } from '@workspace/lib/types/drive-view';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { browseCapabilities } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';
import { LoadingState, RequestAccessView } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useContext, useEffect } from 'react';
import { DriveContext } from './__root';

export const Route = createFileRoute('/fs/$ownerId/$mountId/$pathId')({
    // TanStack's 'stay' is any navigation within this route, such as a row selection or a subfolder: the guard answered
    // on the way in, and the API still refuses a folder the link does not open.
    beforeLoad: ({ cause, context, location, params }) =>
        cause === 'stay' ? undefined : guardLinkRoute(context, location, params.pathId === 'root' ? null : params),
    component: FolderRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => ({
        ...validateDriveSearch(search),
        sharePathId: typeof search.sharePathId === 'string' ? search.sharePathId : undefined,
        shareEmail: typeof search.shareEmail === 'string' ? search.shareEmail : undefined,
    }),
});

function FolderRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { pid, sharePathId, shareEmail } = Route.useSearch();
    const navigate = useNavigate();
    const { rootPath } = useContext(DriveContext);
    const { user } = useAuth();
    const unreadChatIds = useUnreadChatIds(user?.id ?? '');

    // "root" in the URL is an alias: once the root folder is known, the page moves to its real id.
    useEffect(() => {
        if (pathId === 'root' && rootPath) {
            navigate({
                to: Route.fullPath,
                params: { ownerId: rootPath.ownerId, mountId: rootPath.mountId, pathId: rootPath.id },
            });
        }
    }, [pathId, rootPath, navigate]);

    const skipDataFetch = pathId === 'root';
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: folderContentError,
    } = useFolderContent(ownerId, mountId, skipDataFetch ? '' : pathId);
    const { data: selectedPath = null, isLoading: isSelectedPathLoading } = usePathInfo(ownerId, mountId, pid);
    const { data: currentPath = null } = usePathInfo(ownerId, mountId, pathId);
    const { data: shareTargetPath = null } = usePathInfo(ownerId, mountId, sharePathId);
    const shareDialogOpen = !!sharePathId && !!shareTargetPath;

    // This listing needs the parent folder; a viewer shared only ?pid= can still open that item.
    const isForbidden = folderContentError instanceof AppError && folderContentError.status === 403;
    const selectedItemUrl = isForbidden && selectedPath ? getDriveShareUrl(selectedPath) : undefined;
    useEffect(() => {
        if (selectedItemUrl) window.location.replace(selectedItemUrl);
    }, [selectedItemUrl]);

    // One capability set for menus, detail column and quick look.
    const capabilities = browseCapabilities(
        useCanWriteFolder(ownerId, mountId, pathId),
        useWritesByName(ownerId, mountId, pathId),
    );

    const { onRowSelect, onRowActivate, onQuickLook, onClose, onAfterAction } = useDriveListRoute({
        items: folderContents,
        capabilities,
        onOpenFolder: (path) =>
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId: path.id },
                search: { pid: undefined },
            }),
        pid,
        setSelectedItem: (path, { replace, state }) =>
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: (prev) => ({ ...prev, pid: path?.id }),
                replace,
                state,
            }),
    });

    // A replace, so back after closing it never lands on the link that opened it.
    const handleShareDialogClose = (open: boolean) => {
        if (!open) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: (prev) => ({ ...prev, sharePathId: undefined, shareEmail: undefined }),
                replace: true,
                state: true,
            });
        }
    };

    if (pathId === 'root' && !rootPath) {
        return <LoadingState />;
    }

    if (isForbidden) {
        if (isSelectedPathLoading || selectedPath) return <LoadingState />;
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
    }

    return (
        <>
            <DriveLayout
                ownerId={ownerId}
                mountId={mountId}
                pathId={pathId}
                folderContents={folderContents}
                isLoading={isFolderContentLoading}
                error={folderContentError}
                selectedPath={selectedPath}
                currentPath={currentPath}
                onRowSelect={onRowSelect}
                onRowActivate={onRowActivate}
                onOpenSharedWithMe={() => navigate({ to: '/shared/$to', params: { to: 'with-me' } })}
                onClose={onClose}
                onAfterAction={onAfterAction}
                capabilities={capabilities}
                onQuickLook={onQuickLook}
                pid={pid}
                unreadPathIds={unreadChatIds}
            />
            {/* Mounted with no path too, so Email collaborators, opened from Share, outlives the closed Share. */}
            {user && (
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
