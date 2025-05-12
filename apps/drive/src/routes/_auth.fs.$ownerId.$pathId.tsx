import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EigenLoader} from "@workspace/ui";
import {useFolderContent, useInvalidateFolder, usePathInfo} from '@workspace/lib/drive';
import {useContext, useEffect, useState} from "react";
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useIsMobile} from "@workspace/lib/media";
import {DriveContext} from "./_auth";
import {FilePreview} from '../components/drive/file-preview';

// Define search params type
export interface DriveSearchParams {
    pid?: string;
}

export const Route = createFileRoute('/_auth/fs/$ownerId/$pathId')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {ownerId, pathId} = Route.useParams();
    const {pid} = Route.useSearch();
    const navigate = useNavigate();
    const invalidateFolder = useInvalidateFolder();
    const isMobile = useIsMobile();
    const {rootPath} = useContext(DriveContext);
    const [preview, setPreview] = useState<{ url: string; mimeType: string } | null>(null);

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootPath) {
            navigate({
                to: Route.fullPath,
                params: {ownerId: rootPath.ownerId, pathId: rootPath.id}
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
    } = useFolderContent(ownerId, skipDataFetch ? '' : pathId);
    const {data: selectedPath = null} = usePathInfo(ownerId, pid);
    const {data: currentPath = null} = usePathInfo(ownerId, pathId);

    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        // Handle preview behavior when using keyboard navigation
        const mimeType = path.mimeType || "";
        if (preview !== null) {
            // If a preview is already open
            if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
                // Update the preview if new selection is also previewable
                const url = `${import.meta.env.VITE_API_HOST}/drive/embed/${path.ownerId}/${path.id}/${path.name}`;
                setPreview({url, mimeType});
            } else {
                // Close the preview if the new selection isn't previewable
                setPreview(null);
            }
        }

        if (isMobile && (path.type === 'folder' || path.type === 'doc' || path.type === 'stickies')) {
            onRowActivate(path);
        } else if (currentPath?.parentId === path.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: path.id},
                search: {pid: undefined}
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId},
                search: {pid: path.id}
            });
        }
    };

    const onRowActivate = (path: DrivePath) => {
        const mimeType = path.mimeType || "";

        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: path.id},
                search: {pid: undefined}
            });
        } else if (path.type === 'doc') {
            const url = `${import.meta.env.VITE_APP_DOCS_URL}/doc/${path.ownerId}/${path.id}`;
            document.location.href = url;
        } else if (path.type === 'stickies') {
            const url = `${import.meta.env.VITE_APP_STICKIES_URL}/board/${path.ownerId}/${path.id}`;
            document.location.href = url;
        } else if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
            const url = `${import.meta.env.VITE_API_HOST}/drive/embed/${path.ownerId}/${path.id}/${path.name}`;
            setPreview({url, mimeType: mimeType});
        } else {
            const url = `${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`;
            window.open(url, "_blank");
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {ownerId, pathId},
            search: {pid: undefined}
        });
    };

    // Callback die door DriveLayout wordt aangeroepen na acties
    const handleAfterAction = (actionType: string, data: any) => {
        // Invalidate data after mutations
        invalidateFolder(pathId);

        // Alleen navigatie na verwijderen als het item dat geselecteerd was verwijderd is
        if (actionType === 'delete' && pid === data.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId},
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
            />
            <DriveLayout
                ownerId={ownerId}
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
                isMobile={isMobile}
                showBreadcrumb={true}
                pid={pid}
            />
        </>
    );
}