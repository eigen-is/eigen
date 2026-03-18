import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {DEFAULT_MOUNT_ID, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams, isDocumentType, isFolderType, isInlineEditable} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/app/layout-context.tsx";
import {openDocument} from "@workspace/lib/api";
import {usePreview} from '@workspace/ui/components/layout/preview-provider';

export const Route = createFileRoute('/_auth/mime/$mimeType')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        return {pid, uid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {mimeType} = Route.useParams();
    const navigate = useNavigate();
    const {pid} = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const mountId = DEFAULT_MOUNT_ID;
    const {data: selectedPath = null} = usePathInfo(ownerId, mountId, pid);
    const {isMobile} = useLayout();
    const {openPreview, updatePreview, isPreviewOpen} = usePreview();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                params: {mimeType},
                search: {pid: path.id}
            });
        }
    };

    const onQuickLook = (path: DrivePath, sortedSiblings: DrivePath[]) => {
        openPreview(path, sortedSiblings);
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({to: Route.fullPath, params: {mimeType}, search: {pid: undefined}});
        } else if (isDocumentType(path.type)) {
            openDocument(path);
        } else if (isInlineEditable(path.mimeType, path.name)) {
            navigate({to: '/edit/$ownerId/$mountId/$pathId', params: {ownerId: path.ownerId, mountId: path.mountId, pathId: path.id}});
        } else {
            openPreview(path);
        }
    };

    const handleBackToList = () => {
        navigate({to: Route.fullPath, params: {mimeType}});
    };

    if (isFolderContentLoadingError) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <>
            <DriveLayout
                pid={pid}
                selectedPath={selectedPath}
                ownerId={ownerId}
                mountId={mountId}
                folderContents={folderContents}
                isLoading={isFolderContentLoading}
                error={isFolderContentLoadingError}
                onRowSelect={onRowSelect}
                onRowActivate={onRowActivate}
                onBackToList={handleBackToList}
                onAfterAction={() => {}}
                allowDelete={true}
                allowShare={true}
                allowCreateFolder={false}
                allowUpload={false}
                allowCreateDoc={false}
                allowCreateStickies={false}
                showBreadcrumb={false}
                onQuickLook={onQuickLook}
            />
        </>
    );
}
