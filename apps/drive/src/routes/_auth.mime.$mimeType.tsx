import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { getDriveItemUrl, openDocument } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useAggregateMimeContent, usePathInfo } from '@workspace/lib/drive';
import {
    type DrivePath,
    type DriveSearchParams,
    type EigenDocType,
    getEigenDocInfoByMime,
    isDocumentType,
    isFolderType,
    isInlineEditable,
} from '@workspace/lib/types/drive';
import { NotFound } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DRIVE_CAPABILITIES } from '@workspace/ui/components/layout/drive/drive-capabilities';
import { DriveLayout } from '@workspace/ui/components/layout/drive/drive-layout';
import { usePreview } from '@workspace/ui/components/layout/preview-provider';
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
    const { isMobile } = useLayout();
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError,
    } = useAggregateMimeContent(mimeType);

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                params: { mimeType },
                search: { pid: path.id, uid: path.ownerId, mid: path.mountId },
            });
        }
    };

    const onQuickLook = (path: DrivePath, sortedSiblings: DrivePath[]) => {
        openPreview(path, sortedSiblings);
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({ to: Route.fullPath, params: { mimeType }, search: { pid: undefined } });
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
        navigate({ to: Route.fullPath, params: { mimeType } });
    };

    if (isFolderContentLoadingError) {
        return <NotFound />;
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
