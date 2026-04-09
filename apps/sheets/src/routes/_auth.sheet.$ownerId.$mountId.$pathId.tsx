import { createFileRoute } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
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

    const canWrite = docInfo?.canWrite ?? false;
    const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading) return <LoadingState />;
    if (!path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return (
        <>
            <SheetEditor
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
                initialChatName={chat}
            />
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </>
    );
}
