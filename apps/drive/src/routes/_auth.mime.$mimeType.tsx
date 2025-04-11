import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {useInvalidateFolder, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useAuth} from '@workspace/lib/auth/auth-context.js';
import {useIsMobile} from "@workspace/lib/media";

export interface DriveSearchParams {
    pid?: string;
}

export const Route = createFileRoute('/_auth/mime/$mimeType')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {mimeType} = Route.useParams();
    const navigate = useNavigate();
    const {pid} = Route.useSearch();
    const invalidateFolder = useInvalidateFolder();
    const auth = useAuth();
    const ownerId = auth?.user?.id;
    const {data: selectedPath = null} = usePathInfo(ownerId, pid);
    const isMobile = useIsMobile();

    // Fetch folder content and path information
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);

    // Handle row click to show path details
    const handleRowClick = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: '/fs/$ownerId/$pathId',
                params: {ownerId: path.ownerId, pathId: path.id},
                search: {pid: undefined}
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: {mimeType},
                search: {pid: path.id}
            });
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {mimeType}
        });
    };

    // Callback die door DriveLayout wordt aangeroepen na acties
    const handleAfterAction = (actionType: string, data: any) => {
                
    };

    if (isFolderContentLoadingError) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={ownerId}
            folderContents={folderContents}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowClick={handleRowClick}
            onBackToList={handleBackToList}
            onAfterAction={handleAfterAction}
            allowDelete={true}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={false}
            allowCreateStickies={false}
            isMobile={isMobile}
            showBreadcrumb={false}
        />
    );
}