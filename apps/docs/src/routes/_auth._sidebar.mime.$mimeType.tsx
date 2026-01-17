import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath} from "@apps/api/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useIsMobile} from "@workspace/lib/media";
import {useContext} from 'react';
import {DriveContext} from './_auth._sidebar';

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
    const {rootPath} = useContext(DriveContext);

    // Fetch folder content and path information
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);


    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        if (isMobile && (path.type === 'folder' || path.type === 'doc')) {
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
        if (path.type === 'doc') {
            const url = `${import.meta.env.VITE_APP_DOCS_URL}/doc/${path.ownerId}/${path.id}`;
            document.location.href = url;
        } else if (path.type === 'stickies') {
            const url = `${import.meta.env.VITE_APP_STICKIES_URL}/board/${path.ownerId}/${path.id}`;
            document.location.href = url;
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
                navigate({
                    to: '/mime/$mimeType',
                    params: {mimeType: 'application-eigendoc'}
                });
            }}
            allowDelete={true}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={true}
            allowCreateStickies={false}
            isMobile={isMobile}
            showBreadcrumb={false}
            currentPath={rootPath}
        />
    );
}