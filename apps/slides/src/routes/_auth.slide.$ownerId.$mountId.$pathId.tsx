import { createFileRoute } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { useEigenDocEditorRoute, useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { SlideEditor } from '../components/slides/editor';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
    validateSearch: eigenDocEditorValidateSearch,
});

function SlideView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
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
