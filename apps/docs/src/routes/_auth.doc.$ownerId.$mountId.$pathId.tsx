import { createFileRoute } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/layout/drive';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useEigenDocEditorRoute, useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { CollaborativeEditor } from '../components/docs/editor';

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
    validateSearch: eigenDocEditorValidateSearch,
});

function CollaborativeTextEditor() {
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

    if (isLoading) {
        return <LoadingState />;
    }

    if (!docInfo?.canRead || !path) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
    }

    return (
        <>
            <div className="flex-1 overflow-hidden">
                <CollaborativeEditor
                    path={path}
                    canWrite={docInfo.canWrite}
                    mediaFolderId={mediaFolderId}
                    chatFolderId={chatFolderId}
                    onAccessDialogOpen={openAccessDialog}
                    initialChatName={chat}
                    initialSearchTerm={initialSearchTerm}
                />
            </div>
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={path} />
        </>
    );
}
