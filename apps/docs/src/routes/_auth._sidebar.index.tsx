import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {DEFAULT_MOUNT_ID, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams, isDocumentType} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/app/layout-context.tsx";
import {useContext} from 'react';
import {DriveContext} from './__root';
import {openDocument} from "@workspace/lib/api.ts";
import {NotFound} from '@workspace/ui';

const MIME_TYPE = 'application-eigendoc';

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        const uid = typeof search.uid === 'string' ? search.uid : undefined;
        const mid = typeof search.mid === 'string' ? search.mid : undefined;
        return {pid, uid, mid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const navigate = useNavigate();
    const {pid, mid} = Route.useSearch();
    const {user} = useAuth();
    const ownerId = user!.id;
    const {rootPath} = useContext(DriveContext);
    const {data: selectedPath = null} = usePathInfo(ownerId, mid || DEFAULT_MOUNT_ID, pid);
    const {isMobile} = useLayout();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, MIME_TYPE);

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && isDocumentType(path.type)) {
            onRowActivate(path);
        } else {
            navigate({to: '/', search: {pid: path.id, mid: path.mountId}});
        }
    };

    const onRowActivate = (path: DrivePath) => {
        openDocument(path);
    };

    const handleBackToList = () => {
        navigate({to: '/'});
    };

    if (isFolderContentLoadingError) {
        return <NotFound/>;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={ownerId}
            mountId={mid || DEFAULT_MOUNT_ID}
            folderContents={folderContents}
            isLoading={isFolderContentLoading}
            error={isFolderContentLoadingError}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            onBackToList={handleBackToList}
            onAfterAction={() => navigate({to: '/'})}
            allowDelete={true}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={true}
            allowCreateStickies={false}
            allowCreateChat={false}
            allowCreateSlides={false}
            allowCreateSheets={false}
            showBreadcrumb={false}
            currentPath={rootPath}
        />
    );
}
