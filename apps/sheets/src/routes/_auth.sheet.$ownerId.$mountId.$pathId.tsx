import { createFileRoute } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteSelection } from '@workspace/lib/command-palette';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { DriveAccessDialog } from '@workspace/ui/components/layout/drive/drive-access-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SheetEditor } from '../components/sheets/editor';

export const Route = createFileRoute('/_auth/sheet/$ownerId/$mountId/$pathId')({
    component: SheetView,
    validateSearch: (search: Record<string, unknown>) => ({
        chat: typeof search.chat === 'string' ? search.chat : undefined,
    }),
});

function SheetView() {
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
    // (Mail to…, Copy link, …) surface from anywhere. Memoized to keep the wrapper's
    // identity stable across re-renders (avoids a publication-effect → context-update
    // → re-render loop).
    const paletteSelection = useMemo(() => (path ? { items: [path] } : null), [path]);
    usePaletteSelection(paletteSelection);

    const canWrite = docInfo?.canWrite ?? false;
    const mediaFolderId = useMemo(() => {
        return docInfo?.folderContents?.find((item) => item.name === 'media')?.id ?? null;
    }, [docInfo?.folderContents]);
    const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading) return <LoadingState />;
    if (!path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <SheetEditor
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
                initialChatName={chat}
            />
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </MediaResolverProvider>
    );
}
