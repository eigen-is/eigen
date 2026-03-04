import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {DEFAULT_MOUNT_ID, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/layout-context";
import {getSheetUrl} from "@workspace/lib/api";

export const Route = createFileRoute('/_auth/_sidebar/mime/$mimeType')({
    component: SheetsRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function SheetsRoute() {
    const {mimeType} = Route.useParams();
    const navigate = useNavigate();
    const {pid} = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const mountId = DEFAULT_MOUNT_ID;
    const {data: selectedPath = null} = usePathInfo(ownerId, mountId, pid);
    const {isMobile} = useLayout();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && (path.type === 'sheets')) {
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
        if (path.type === 'sheets') {
            document.location.href = getSheetUrl(path.ownerId, path.mountId, path.id);
        }
    };

    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {mimeType}
        });
    };

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
            }}
            allowDelete={true}
            allowShare={true}
            allowCreateFolder={false}
            allowUpload={false}
            allowCreateDoc={false}
            allowCreateStickies={false}
            allowCreateChat={false}
            allowCreateSlides={false}
            allowCreateSheets={false}
            showBreadcrumb={false}
        />
    );
}
