import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {usePathInfo, useSharedPaths} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api-server/types/drive";
import {useAuth} from '@workspace/lib/auth/auth-context.js';
import {useIsMobile} from "@workspace/lib/media";
import {EigenLoader} from '@workspace/ui';

export interface DriveSearchParams {
    pid?: string;
    uid?: string;
}

export const Route = createFileRoute('/_auth/_sidebar/shared/$to')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {to} = Route.useParams();
    const navigate = useNavigate();
    const {uid, pid} = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth?.user?.id;
    const {data: selectedPath = null} = usePathInfo(uid || '', pid || '');
    const isMobile = useIsMobile();

    // Fetch folder content and path information
    const {
        data: unfilteredFolderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useSharedPaths(to as 'by-me' | 'with-me');

    const folderContents = unfilteredFolderContents?.filter((path) => path.type === 'folder' || path.type === 'doc') || [];

    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        if (isMobile && (path.type === 'folder' || path.type === 'doc')) {
            onRowActivate(path);
        } else {
            navigate({
                to: Route.fullPath,
                params: {to},
                search: {pid: path.id, uid: path.ownerId}
            });
        }
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: '/fs/$ownerId/$pathId',
                params: {ownerId: path.ownerId, pathId: path.id}
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
            params: {to}
        });
    };

    if (isFolderContentLoadingError) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    if (isFolderContentLoading) {
        return <EigenLoader/>;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            folderContents={folderContents ?? []}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => {
            }}
            allowDelete={to === 'by-me'}
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