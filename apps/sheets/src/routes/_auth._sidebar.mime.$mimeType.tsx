import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams, isDocumentType} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/app/layout-context.tsx";
import {useContext} from 'react';
import {DriveContext} from './__root';
import {openDocument} from "@workspace/lib/api.ts";

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
    const ownerId = auth.user!.id;
    const {rootPath, mountId} = useContext(DriveContext);
    const {data: selectedPath = null} = usePathInfo(ownerId, mountId, pid);
    const {isMobile} = useLayout();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
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
        openDocument(path);
    };

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
            mountId={mountId}
            folderContents={folderContents}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => {
                navigate({
                    to: '/mime/$mimeType',
                    params: {mimeType: 'application-eigensheets'}
                });
            }}
            allowDelete={true}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={true}
            allowCreateStickies={false}
            showBreadcrumb={false}
            currentPath={rootPath}
        />
    );
}