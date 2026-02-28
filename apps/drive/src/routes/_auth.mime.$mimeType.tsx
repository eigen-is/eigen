import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {DEFAULT_MOUNT_ID, useMimeContent, usePathInfo} from '@workspace/lib/drive';
import {DriveLayout} from "@workspace/ui/components/layout/drive/drive-layout";
import {DrivePath, DriveSearchParams} from "@workspace/lib/types/drive";
import {useAuth} from '@workspace/lib/auth';
import {useLayout} from "@workspace/ui/components/layout/layout-context";
import {useState} from "react";
import {FilePreview} from '@workspace/ui/components/layout/drive/file-preview';
import {getDriveDownloadUrl, getDriveEmbedUrl} from "@workspace/lib/api";

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
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const mountId = DEFAULT_MOUNT_ID;
    const {data: selectedPath = null} = usePathInfo(ownerId, mountId, pid);
    const {isMobile} = useLayout();
    const [preview, setPreview] = useState<{ url: string; mimeType: string } | null>(null);

    // Fetch folder content and path information
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useMimeContent(ownerId, mimeType);

    // Handle row click to show path details
    const onRowSelect = (path: DrivePath) => {
        // Handle preview behavior when using keyboard navigation
        const fileMimeType = path.mimeType || "";
        if (preview !== null) {
            // If a preview is already open
            if (fileMimeType.startsWith("image/") || fileMimeType.startsWith("video/")) {
                // Update the preview if new selection is also previewable
                const url = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name);
                setPreview({url, mimeType: fileMimeType});
            } else {
                // Close the preview if the new selection isn't previewable
                setPreview(null);
            }
        }

        if (isMobile && (path.type === 'folder' || path.type === 'doc' || path.type === 'stickies' || path.type === 'chat')) {
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
        const fileMimeType = path.mimeType || "";

        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {mimeType},
                search: {pid: undefined}
            });
        } else if (path.type === 'doc') {
            const url = `${import.meta.env.VITE_APP_DOCS_URL}/doc/${path.ownerId}/${path.mountId}/${path.id}`;
            document.location.href = url;
        } else if (path.type === 'stickies') {
            const url = `${import.meta.env.VITE_APP_STICKIES_URL}/board/${path.ownerId}/${path.mountId}/${path.id}`;
            document.location.href = url;
        } else if (path.type === 'chat') {
            const url = `${import.meta.env.VITE_APP_CHAT_URL}/${path.ownerId}/${path.mountId}/${path.id}`;
            document.location.href = url;
        } else if (fileMimeType.startsWith("image/") || fileMimeType.startsWith("video/")) {
            const url = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name);
            setPreview({url, mimeType: fileMimeType});
        } else {
            const url = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
            window.open(url, "_blank");
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
        <>
            <FilePreview
                url={preview?.url || ''}
                mimeType={preview?.mimeType || ''}
                onClose={() => setPreview(null)}
                open={preview !== null}
            />
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
                showBreadcrumb={false}
            />
        </>
    );
}