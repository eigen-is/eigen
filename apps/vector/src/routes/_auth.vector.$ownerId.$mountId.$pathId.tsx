import { createFileRoute } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { useEigenDocEditorRoute } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { VectorEditor } from '../components/vector/editor';

export const Route = createFileRoute('/_auth/vector/$ownerId/$mountId/$pathId')({
    component: VectorView,
    validateSearch: eigenDocEditorValidateSearch,
});

function VectorView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    // ?chat=<chatName> deep-links straight to a comment thread (validated by eigenDocEditorValidateSearch;
    // ?q= stays unconsumed — vector has no in-document find bar, D15 is out of this program).
    const { chat } = Route.useSearch();
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
            <VectorEditor
                ownerId={ownerId}
                path={path}
                canWrite={docInfo.canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={openAccessDialog}
                initialChatName={chat}
            />
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </>
    );
}
