// Drive's folder page: the folder the URL names, with the item ?pid= selects open beside the list. It
// resolves the mount's "root" alias, sends a viewer who may open only the selected item to that item's
// share link, offers a request for access when the folder is closed to the viewer, and opens the share
// dialog that ?sharePathId= asks for.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveShareUrl } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useUnreadChatIds } from '@workspace/lib/chat';
import {
    useCheckPermissions,
    useFolderContent,
    useIsEffectiveOwner,
    usePathInfo,
    validateDriveSearch,
} from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveSearchParams } from '@workspace/lib/types/drive-view';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { browseCapabilities } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';
import { useContext, useEffect } from 'react';
import { DriveContext } from './__root';

export const Route = createFileRoute('/_auth/fs/$ownerId/$mountId/$pathId')({
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
    const { user } = Route.useRouteContext();
    const unreadChatIds = useUnreadChatIds(user.id);

    // "root" in the URL is an alias: once the root folder is known, the page moves to its real id.
    useEffect(() => {
        if (pathId === 'root' && rootPath) {
            navigate({
                to: Route.fullPath,
                params: { ownerId: rootPath.ownerId, mountId: rootPath.mountId, pathId: rootPath.id },
            });
        }
    }, [pathId, rootPath, navigate, ownerId]);

    const skipDataFetch = pathId === 'root';
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: folderContentError,
    } = useFolderContent(ownerId, mountId, skipDataFetch ? '' : pathId);
    const { data: selectedPath = null, isLoading: isSelectedPathLoading } = usePathInfo(ownerId, mountId, pid);
    const { data: currentPath = null } = usePathInfo(ownerId, mountId, pathId);
    const { data: shareTargetPath = null } = usePathInfo(ownerId, mountId, sharePathId || '');
    const shareDialogOpen = !!sharePathId && !!shareTargetPath;

    // This listing needs the parent folder; a viewer shared only ?pid= can still open that item.
    const isForbidden = folderContentError instanceof AppError && folderContentError.status === 403;
    const selectedItemUrl = isForbidden && selectedPath ? getDriveShareUrl(selectedPath) : undefined;
    useEffect(() => {
        if (selectedItemUrl) window.location.replace(selectedItemUrl);
    }, [selectedItemUrl]);

    // One capability set for menus, detail column and quick look; owners skip the permissions round trip.
    const isOwner = useIsEffectiveOwner(ownerId);
    const { data: permissions } = useCheckPermissions(ownerId, mountId, isOwner || skipDataFetch ? undefined : pathId);
    const capabilities = browseCapabilities(isOwner || permissions?.canWrite === true);

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: folderContents,
        capabilities,
        onOpenFolder: (path: DrivePath) =>
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId: path.id },
                search: { pid: undefined },
            }),
        onSelectItem: (path: DrivePath) => {
            if (currentPath?.parentId === path.id) {
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
        },
    });

    const handleShareDialogClose = (open: boolean) => {
        if (!open) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: { pid, sharePathId: undefined, shareEmail: undefined },
            });
        }
    };

    // The back button a narrow screen shows over an open item.
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: { pid: undefined },
        });
    };

    // A deleted item that was open closes with it.
    const handleAfterAction = (actionType: string, data: Record<string, unknown>) => {
        if (actionType === 'delete' && pid === data.id) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: { pid: undefined },
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
                onBackToList={handleBackToList}
                onAfterAction={handleAfterAction}
                capabilities={capabilities}
                onQuickLook={onQuickLook}
                pid={pid}
                unreadPathIds={unreadChatIds}
            />
            {/* Mounted with no path too, so Email collaborators, opened from Share, outlives the closed Share. */}
            <DriveAccessDialog
                open={shareDialogOpen}
                onOpenChange={handleShareDialogClose}
                path={shareTargetPath}
                prefillEmail={shareEmail}
            />
        </>
    );
}
