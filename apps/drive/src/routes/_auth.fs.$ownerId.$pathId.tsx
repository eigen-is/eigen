import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EigenLoader} from "@workspace/ui";
import {useFolderContent, useInvalidateFolder, usePathInfo, useRootFolder} from '@workspace/lib/drive';
import {useEffect} from "react";
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useIsMobile} from "@workspace/lib/media";

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

    // Get the root folder ID to replace "root" pathId
    const {data: rootFolder, isLoading: isRootLoading} = useRootFolder(ownerId);

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootFolder?.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: rootFolder.id}
            });
        }
    }, [pathId, rootFolder, navigate]);

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
    const handleRowClick = (path: DrivePath) => {
        if (path.type === 'folder') {
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
    if ((pathId === 'root' && isRootLoading)) {
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
            onRowClick={handleRowClick}
            onBackToList={handleBackToList}
            onAfterAction={handleAfterAction}
            allowCreateFolder={true}
            allowDelete={true}
            allowShare={true}
            allowUpload={true}
            isMobile={isMobile}
            showBreadcrumb={true}
            pid={pid}
        />
    );
}