// Drive's filter by type, such as All images or All docs: every file of one kind the viewer can open,
// wherever it lives, with the selected one's ?pid=&uid=&mid= detail beside the list. A document kind
// offers New for that kind only.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { DEFAULT_MOUNT_ID, useAggregateMimeContent, usePathInfo, validateDriveSearch } from '@workspace/lib/drive';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { getEigenDocInfoByMime } from '@workspace/lib/types/drive';
import { FILTER_LABELS } from '@workspace/ui';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/drive/use-drive-list-route';

export const Route = createFileRoute('/_auth/mime/$mimeType')({
    component: MimeRoute,
    validateSearch: validateDriveSearch,
});

function MimeRoute() {
    const { mimeType } = Route.useParams();
    const navigate = useNavigate();
    const { pid, uid, mid } = Route.useSearch();
    const { user } = Route.useRouteContext();
    const ownerId = user.id;
    const { data: selectedPath = null } = usePathInfo(uid || ownerId, mid || DEFAULT_MOUNT_ID, pid);

    const { data: folderContents = [], isLoading, error } = useAggregateMimeContent(mimeType);

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: folderContents,
        capabilities: DRIVE_CAPABILITIES.listing,
        onOpenFolder: (path: DrivePath) =>
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            }),
        onSelectItem: (path: DrivePath) =>
            navigate({
                to: Route.fullPath,
                params: { mimeType },
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            }),
    });

    const handleBackToList = () => {
        navigate({ to: Route.fullPath, params: { mimeType } });
    };

    // The mime route is keyed on the url-slug form (`application-eigendoc`); resolve it
    // back to the matching EigenDocType so create is offered only for that kind.
    const matchedType = getEigenDocInfoByMime(mimeType)?.type;
    const createTypes = new Set<EigenDocType>(matchedType ? [matchedType] : []);

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
            capabilities={{ ...DRIVE_CAPABILITIES.listing, createTypes }}
            title={FILTER_LABELS[mimeType]}
            onQuickLook={onQuickLook}
        />
    );
}
