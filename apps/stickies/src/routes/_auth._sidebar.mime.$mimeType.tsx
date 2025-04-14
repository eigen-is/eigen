import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useAuth} from '@workspace/lib/auth/auth-context.js';
import {useIsMobile} from "@workspace/lib/media";

export interface DriveSearchParams {
    pid?: string;
}

export const Route = createFileRoute('/_auth/_sidebar/mime/$mimeType')({
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
    const onRowSelect = (path: DrivePath) => {
        if (isMobile && (path.type === 'folder' || path.type === 'stickies')) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                params: {mimeType},
                search: {pid: path.id}
            });
        }
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {mimeType},
                search: {pid: undefined}
            });
        } else if (path.type === 'doc') {
            navigate({
                to: '/doc/$ownerId/$pathId',
                params: {ownerId: path.ownerId, pathId: path.id}
            });
        } else {
            // todo: for some types we could show a fullscreen preview
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {mimeType}
        });
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
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => {
            }}
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