import { createFileRoute } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteDocSelection } from '@workspace/lib/command-palette';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CollaborativeEditor } from '../components/docs/editor';

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
    validateSearch: (search: Record<string, unknown>) => ({
        chat: typeof search.chat === 'string' ? search.chat : undefined,
    }),
});

function CollaborativeTextEditor() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat } = Route.useSearch();
    const { data: docInfo, isLoading } = useCollabDocumentInfo(ownerId, mountId, pathId);
    const { setDocumentTitle } = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path?.name?.replace(/\.eigen\w+$/, '') || '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    // Publish the open document as a 1-item palette selection so item-aware commands
    // (Mail to…, Copy link, …) surface from anywhere.
    usePaletteDocSelection(docInfo?.path);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const mediaFolderId = useMemo(() => {
        return docInfo?.folderContents?.find((item) => item.name === 'media')?.id ?? null;
    }, [docInfo?.folderContents]);

    const chatFolderId = useMemo(() => {
        return docInfo?.folderContents?.find((item) => item.name === 'chat')?.id ?? null;
    }, [docInfo?.folderContents]);

    if (isLoading) {
        return <LoadingState />;
    }

    if (!docInfo?.canRead || !docInfo.path) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;
    }

    return (
        <>
            <div className="flex-1 overflow-hidden">
                <CollaborativeEditor
                    path={docInfo.path}
                    access={docInfo}
                    mediaFolderId={mediaFolderId}
                    chatFolderId={chatFolderId}
                    onAccessDialogOpen={handleAccessDialogOpen}
                    initialChatName={chat}
                />
            </div>
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={docInfo.path} />
        </>
    );
}
