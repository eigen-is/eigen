import { createFileRoute } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteDocSelection } from '@workspace/lib/command-palette';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SlideEditor } from '../components/slides/editor';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
    validateSearch: (search: Record<string, unknown>) => ({
        chat: typeof search.chat === 'string' ? search.chat : undefined,
    }),
});

function SlideView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat } = Route.useSearch();
    const { data: docInfo, isLoading } = useCollabDocumentInfo(ownerId, mountId, pathId);
    const { setDocumentTitle } = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path ? stripEigenExtension(docInfo.path.name) : '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    const path = useMemo(
        () =>
            docInfo?.path
                ? {
                      ...docInfo.path,
                      mountId,
                  }
                : null,
        [docInfo?.path, mountId],
    );

    // Publish the open document as a 1-item palette selection so item-aware commands
    // (Mail to…, Copy link, …) surface from anywhere.
    usePaletteDocSelection(path);

    const canWrite = docInfo?.canWrite ?? false;
    const mediaFolderId = docInfo?.folderContents?.find((f) => f.name === 'media')?.id ?? null;
    const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading) return <LoadingState />;
    if (!path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return (
        <>
            <SlideEditor
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
                initialChatName={chat}
            />
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </>
    );
}
