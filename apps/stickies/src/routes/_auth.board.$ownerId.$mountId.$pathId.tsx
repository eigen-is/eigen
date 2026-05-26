import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteDocSelection } from '@workspace/lib/command-palette';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
    validateSearch: (search: Record<string, unknown>) => ({
        chat: typeof search.chat === 'string' ? search.chat : undefined,
    }),
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat } = Route.useSearch();
    const navigate = useNavigate();
    const { data: docInfo, isLoading } = useCollabDocumentInfo(ownerId, mountId, pathId);
    const { setDocumentTitle } = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path ? stripEigenExtension(docInfo.path.name) : '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    // Publish the open document as a 1-item palette selection so item-aware commands
    // (Mail to…, Copy link, …) surface from anywhere.
    usePaletteDocSelection(docInfo?.path);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const handleClearChat = useCallback(() => {
        navigate({
            to: Route.fullPath,
            params: { ownerId, mountId, pathId },
            search: (prev) => ({ ...prev, chat: undefined }),
            replace: true,
        });
    }, [navigate, ownerId, mountId, pathId]);

    const chatFolderId = useMemo(() => {
        return docInfo?.folderContents?.find((item) => item.name === 'chat')?.id ?? null;
    }, [docInfo?.folderContents]);

    if (isLoading) return <LoadingState />;
    if (!docInfo?.canRead || !docInfo.path) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
    }

    return (
        <>
            <StickiesBoard
                ownerId={ownerId}
                path={docInfo.path}
                canWrite={docInfo.canWrite}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
                initialChatName={chat}
                onClearInitialChat={handleClearChat}
            />
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={docInfo.path} />
        </>
    );
}
