import { createFileRoute } from '@tanstack/react-router';
import { EigenDocRouteStatus, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
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
        isError,
        error,
        refetch,
        path,
        mediaFolderId,
        chatFolderId,
        accessDialogOpen,
        openAccessDialog,
        setAccessDialogOpen,
    } = useEigenDocEditorRoute(ownerId, mountId, pathId);

    if (!docInfo) return <EigenDocRouteStatus isError={isError} error={error} onRetry={refetch} />;

    if (!docInfo.canRead || !path) {
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
