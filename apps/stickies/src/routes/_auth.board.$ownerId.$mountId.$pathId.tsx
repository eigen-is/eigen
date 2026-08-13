import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { DriveAccessDialog } from '@workspace/ui/components/drive/drive-access-dialog';
import { useEigenDocEditorRoute, useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { useCallback } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
    validateSearch: eigenDocEditorValidateSearch,
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, card, q } = Route.useSearch();
    const navigate = useNavigate();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
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

    const handleClearCard = useCallback(() => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: (prev) => ({ ...prev, card: undefined }),
            replace: true,
        });
    }, [navigate, ownerId, mountId, pathId]);

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
                initialCardId={card}
                onClearInitialCard={handleClearCard}
            />
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={path} />
        </>
    );
}
