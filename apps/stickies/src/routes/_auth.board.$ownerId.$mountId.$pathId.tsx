import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/layout/drive';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useEigenDocEditorRoute } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { useCallback, useEffect, useState } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
    validateSearch: eigenDocEditorValidateSearch,
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const navigate = useNavigate();
    // Latch once — the board gates on Yjs sync, so a clear can outrun the provider's mount.
    const [initialSearchTerm] = useState(q);
    const {
        docInfo,
        isLoading,
        path,
        chatFolderId,
        mediaFolderId,
        accessDialogOpen,
        openAccessDialog,
        setAccessDialogOpen,
    } = useEigenDocEditorRoute(ownerId, mountId, pathId);

    const handleClearChat = useCallback(() => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: (prev) => ({ ...prev, chat: undefined }),
            replace: true,
        });
    }, [navigate, ownerId, mountId, pathId]);

    // handleClearChat above is child-driven (the board fires it after consuming ?chat=); the ?q=
    // clear is parent-driven and safe only because initialSearchTerm is latched.
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
    if (!docInfo?.canRead || !path) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
    }

    return (
        <>
            <StickiesBoard
                ownerId={ownerId}
                path={path}
                canWrite={docInfo.canWrite}
                chatFolderId={chatFolderId}
                mediaFolderId={mediaFolderId}
                onAccessDialogOpen={openAccessDialog}
                initialChatName={chat}
                onClearInitialChat={handleClearChat}
                initialSearchTerm={initialSearchTerm}
            />
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={path} />
        </>
    );
}
