import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EigenLoader} from "@workspace/ui";
import {useFolderContent, usePathInfo} from '@workspace/lib/drive';
import {useContext, useEffect, useState} from "react";
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams, isDocumentType, isFolderType} from "@workspace/lib/types/drive";
import {useLayout} from "@workspace/ui/components/layout/app/layout-context.tsx";
import {DriveContext} from "./__root";
import {FilePreview} from '@workspace/ui/components/layout/drive/file-preview';
import {getDriveDownloadUrl, getDriveEmbedUrl, openDocument} from "@workspace/lib/api";

export const Route = createFileRoute('/_auth/fs/$ownerId/$mountId/$pathId')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {pid} = Route.useSearch();
    const navigate = useNavigate();
    const {isMobile} = useLayout();
    const {rootPath} = useContext(DriveContext);
    const [preview, setPreview] = useState<{ url: string; mimeType: string; aspectRatio?: number } | null>(null);

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootPath) {
            navigate({
                to: Route.fullPath,
                params: {ownerId: rootPath.ownerId, mountId: rootPath.mountId, pathId: rootPath.id}
            });
        }
    }, [pathId, rootPath, navigate, ownerId]);

    // Don't fetch data until we have the actual root folder ID (not "root")
    const skipDataFetch = pathId === 'root';

    // Fetch folder content and path information
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useFolderContent(ownerId, mountId, skipDataFetch ? '' : pathId);
    const {data: selectedPath = null} = usePathInfo(ownerId, mountId, pid);
    const {data: currentPath = null} = usePathInfo(ownerId, mountId, pathId);

    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        // Handle preview behavior when using keyboard navigation
        const mimeType = path.mimeType || "";
        if (preview !== null) {
            // If a preview is already open
            if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
                // Update the preview if new selection is also previewable
                const url = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name);
                const aspectRatio = path.details?.width && path.details?.height ? path.details.width / path.details.height : undefined;
                setPreview({url, mimeType, aspectRatio});
            } else {
                // Close the preview if the new selection isn't previewable
                setPreview(null);
            }
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else if (currentPath?.parentId === path.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, mountId, pathId: path.id},
                search: {pid: undefined}
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: {ownerId, mountId, pathId},
                search: {pid: path.id}
            });
        }
    };

    const onRowActivate = (path: DrivePath) => {
        const mimeType = path.mimeType || "";

        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {ownerId, mountId, pathId: path.id},
                search: {pid: undefined}
            });
        } else if (isDocumentType(path.type)) {
            openDocument(path);
        } else if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
            const url = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name);
            const aspectRatio = path.details?.width && path.details?.height ? path.details.width / path.details.height : undefined;
            setPreview({url, mimeType, aspectRatio});
        } else {
            const url = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
            window.open(url, "_blank");
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {ownerId, mountId, pathId},
            search: {pid: undefined}
        });
    };

    // Callback called by DriveLayout after actions
    const handleAfterAction = (actionType: string, data: any) => {
        // Navigate away from deleted item if it was selected
        if (actionType === 'delete' && pid === data.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, mountId, pathId: pathId},
                search: {pid: undefined}
            });
        }
    };

    // Show loading state while resolving root folder ID
    if (pathId === 'root' && !rootPath) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    if (isFolderContentLoadingError) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <>
            <FilePreview
                url={preview?.url || ''}
                mimeType={preview?.mimeType || ''}
                onClose={() => setPreview(null)}
                open={preview !== null}
                aspectRatio={preview?.aspectRatio ? `${preview.aspectRatio}` : undefined}
            />
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
                allowCreateFolder={true}
                allowCreateDoc={true}
                allowCreateStickies={true}
                allowDelete={true}
                allowShare={true}
                allowUpload={true}
                allowMove={true}
                showBreadcrumb={true}
                pid={pid}
            />
        </>
    );
}