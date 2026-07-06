import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/layout/drive';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useEigenDocEditorRoute } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { useEffect, useState } from 'react';
import { CollaborativeEditor } from '../components/docs/editor';

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
    validateSearch: eigenDocEditorValidateSearch,
});

function CollaborativeTextEditor() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const navigate = useNavigate();
    // Latch the ?q= landing param once: the editor defers its subtree until collab sync, so the
    // DocSearchProvider mounts long after the route resolves — a clear timed against the consumer's
    // mount would race it and wipe q first. Latched, the strip below is timing-proof.
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

    // Strip ?q= from the URL — the latched value already feeds the editor, so this can run at any
    // time. replace:true → no history entry; the link still works for the next visit.
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
                    access={docInfo}
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
