import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {AccessDenied, LoadingState} from '@workspace/ui';
import {useLayout} from '@workspace/ui/components/layout/app/layout-context';
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {StickiesBoard} from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
});

function StickiesRoute() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {setDocumentTitle} = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path?.name?.replace(/\.eigen\w+$/, '') || '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const chatFolderId = useMemo(() => {
        return docInfo?.folderContents?.find((item) => item.name === 'chat')?.id ?? null;
    }, [docInfo?.folderContents]);

    if (isLoading) return <LoadingState/>;
    if (!docInfo?.canRead || !docInfo.path) {
        return <AccessDenied/>;
    }

    return (
        <>
            <StickiesBoard
                ownerId={ownerId}
                path={docInfo.path}
                canWrite={docInfo.canWrite}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
            />
            <DriveAccessDialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen} path={docInfo.path}/>
        </>
    );
}
