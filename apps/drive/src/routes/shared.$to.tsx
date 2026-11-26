// Drive's Shared by me and Shared with me pages: one flat listing of the items the viewer shares or is
// shared, laid out by DriveLayout. Items shared with the viewer belong to other people, so the page
// offers nothing that writes there, and a delete leaves the share. A plain file's public link lands on
// Shared with me without a login, where the listing is that one file, read-only.

import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { usePathInfo, useSharedPaths, validateDriveSearch } from '@workspace/lib/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { selectInSearch, useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';

export const Route = createFileRoute('/shared/$to')({
    component: SharedRoute,
    validateSearch: validateDriveSearch,
    beforeLoad: ({ context, location, params, search: { uid, mid, pid } }) =>
        guardLinkRoute(
            context,
            location,
            params.to === 'with-me' && uid && pid
                ? { ownerId: uid, mountId: mid || DEFAULT_MOUNT_ID, pathId: pid }
                : null,
        ),
});

function SharedRoute() {
    const { to } = Route.useParams();
    const navigate = Route.useNavigate();
    const { uid, pid, mid } = Route.useSearch();
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const { data: selectedPath = null, isLoading: isSelectedPathLoading } = usePathInfo(
        uid || '',
        mid || DEFAULT_MOUNT_ID,
        pid,
    );
    const {
        data: sharedPaths = [],
        isLoading: isSharedLoading,
        error,
    } = useSharedPaths(ownerId, to === 'by-me' ? 'by-me' : 'with-me');

    // A visitor has no shared lists: the page lists the one file their link names, with no list to go back to.
    const page = user
        ? {
              folderContents: sharedPaths,
              isLoading: isSharedLoading,
              // The with-me feed says nothing about the viewer's access to each row, so only the by-me side writes.
              capabilities: { ...DRIVE_CAPABILITIES.listing, canRename: to === 'by-me', canWrite: to === 'by-me' },
              title: to === 'by-me' ? 'Shared by me' : 'Shared with me',
          }
        : {
              folderContents: selectedPath ? [selectedPath] : [],
              isLoading: isSelectedPathLoading,
              capabilities: DRIVE_CAPABILITIES.readOnly,
              title: selectedPath ? stripEigenExtension(selectedPath.name) : undefined,
          };

    const { onRowSelect, onRowActivate, onQuickLook, onClose, onAfterAction } = useDriveListRoute({
        items: page.folderContents,
        capabilities: page.capabilities,
        onOpenFolder: (path) =>
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            }),
        pid,
        setSelectedItem: selectInSearch(navigate),
    });

    return (
        <DriveLayout
            {...page}
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            error={error}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onClose={user ? onClose : undefined}
            onAfterAction={onAfterAction}
            onQuickLook={onQuickLook}
        />
    );
}
