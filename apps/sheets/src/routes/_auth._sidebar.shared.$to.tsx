import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {DEFAULT_MOUNT_ID, usePathInfo, useSharedPaths} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/layout-context";
import {EigenLoader} from '@workspace/ui';
import {getSheetUrl} from "@workspace/lib/api";

export const Route = createFileRoute('/_auth/_sidebar/shared/$to')({
    component: SharedRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function SharedRoute() {
    const {to} = Route.useParams();
    const navigate = useNavigate();
    const {uid, pid} = Route.useSearch();
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const mountId = DEFAULT_MOUNT_ID;
    const {data: selectedPath = null} = usePathInfo(uid || '', mountId, pid || '');
    const {isMobile} = useLayout();

    const {
        data: allContents = [],
        isLoading,
        error
    } = useSharedPaths(ownerId, to as 'by-me' | 'with-me');

    const folderContents = allContents.filter((p: DrivePath) => p.type === 'sheets');

    const onRowSelect = (path: DrivePath) => {
        if (isMobile && path.type === 'sheets') {
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
        if (path.type === 'sheets') {
            document.location.href = getSheetUrl(path.ownerId, path.mountId, path.id);
        }
    };

    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {to}
        });
    };

    if (error) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    if (isLoading) {
        return <EigenLoader/>;
    }

    return (
        <DriveLayout
            pid={pid}
            selectedPath={selectedPath}
            ownerId={uid || ownerId}
            mountId={mountId}
            folderContents={folderContents ?? []}
            isLoading={isLoading}
            error={error}
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
            allowCreateChat={false}
            allowCreateSlides={false}
            allowCreateSheets={false}
            showBreadcrumb={false}
            allowRename={to === 'by-me'}
        />
    );
}
