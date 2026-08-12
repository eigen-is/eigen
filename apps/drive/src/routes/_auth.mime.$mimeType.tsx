import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useAggregateMimeContent, usePathInfo } from '@workspace/lib/drive';
import {
    type DrivePath,
    type DriveSearchParams,
    type EigenDocType,
    getEigenDocInfoByMime,
} from '@workspace/lib/types/drive';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/layout/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/layout/drive/drive-layout';
import { useDriveListRoute } from '@workspace/ui/components/layout/drive/use-drive-list-route';
import { FILTER_LABELS } from '@workspace/ui/components/layout/sidebar/app-sidebar';

export const Route = createFileRoute('/_auth/mime/$mimeType')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>): DriveSearchParams => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return { pid, uid, mid };
    },
});

function DriveRoute() {
    const { mimeType } = Route.useParams();
    const navigate = useNavigate();
    const { pid, uid, mid } = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const { data: selectedPath = null } = usePathInfo(uid || ownerId, mid || DEFAULT_MOUNT_ID, pid);

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useAggregateMimeContent(mimeType);

    const { onRowSelect, onRowActivate, onQuickLook } = useDriveListRoute({
        items: folderContents,
        onOpenFolder: () => navigate({ to: Route.fullPath, params: { mimeType }, search: { pid: undefined } }),
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

    if (isFolderContentLoadingError) {
        return <EmptyState message="Encountering the null vector: a rendezvous with nothing at all." />;
    }

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
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => {}}
            capabilities={{ ...DRIVE_CAPABILITIES.listing, createTypes }}
            title={FILTER_LABELS[mimeType]}
            onQuickLook={onQuickLook}
            getItemHref={getDriveItemUrl}
        />
    );
}
