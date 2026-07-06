import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/layout/drive';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useEigenDocEditorRoute } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { useEffect, useState } from 'react';
import { SlideEditor } from '../components/slides/editor';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
    validateSearch: eigenDocEditorValidateSearch,
});

function SlideView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const navigate = useNavigate();
    // Latch once — the editor gates on Yjs sync, so a clear can outrun the provider's mount.
    const [initialSearchTerm] = useState(q);
    const {
        docInfo,
        isLoading,
        path,
        mediaFolderId,
        chatFolderId,
        accessDialogOpen,
        openAccessDialog,
        setAccessDialogOpen,
    } = useEigenDocEditorRoute(ownerId, mountId, pathId);

    useEffect(() => {
        if (q) {
            navigate({
                to: Route.fullPath,
                params: { ownerId, mountId, pathId },
                search: (prev) => ({ ...prev, q: undefined }),
                replace: true,
            });
        }
    }, [q, navigate, ownerId, mountId, pathId]);

    if (isLoading) return <LoadingState />;
    if (!docInfo?.canRead || !path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return (
        <>
            <SlideEditor
                ownerId={ownerId}
                path={path}
                canWrite={docInfo.canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={openAccessDialog}
                initialChatName={chat}
                initialSearchTerm={initialSearchTerm}
            />
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </>
    );
}
