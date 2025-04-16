import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EigenLoader} from "@workspace/ui";
import {useFolderContent, useInvalidateFolder, usePathInfo} from '@workspace/lib/drive';
import {useContext, useEffect} from "react";
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useIsMobile} from "@workspace/lib/media";
import {DriveContext} from "./_auth";

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
    const {rootPathId} = useContext(DriveContext);

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootPathId) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: rootPathId}
            });
        }
    }, [pathId, rootPathId, navigate, ownerId]);

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
        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: path.id},
                search: {pid: undefined}
            });
        } else if (path.type === 'doc') {
            document.location.href = `${import.meta.env.VITE_APP_DOCS_URL}/doc/${ownerId}/${path.id}`;
        } else if (path.type === 'stickies') {
            document.location.href = `${import.meta.env.VITE_APP_STICKIES_URL}/board/${ownerId}/${path.id}`;
        } else {
            // todo: for some types we could show a fullscreen preview
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
    if (pathId === 'root' && !rootPathId) {
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
            isMobile={isMobile}
            showBreadcrumb={true}
            pid={pid}
        />
    );
}