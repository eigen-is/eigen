import {createFileRoute} from '@tanstack/react-router'
import {useCollabDocumentInfo} from '@workspace/lib/collab'
import {EigenLoader} from '@workspace/ui'
import {useApp} from '@workspace/ui/components/layout/app/layout-context.tsx'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {StickiesBoard} from "../components/stickies/board";
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog'

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
    component: StickiesRoute,
})

function StickiesRoute() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        if (docInfo?.path?.name) setAppName?.(docInfo.path.name.replace('.eigenstickies', ''));
        return () => setAppName?.(originalAppName);
    }, [docInfo?.path, originalAppName, setAppName]);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const chatFolderId = useMemo(() => {
        return docInfo?.folderContents?.find(item => item.name === 'chat')?.id ?? null;
    }, [docInfo?.folderContents]);

    if (isLoading) return <EigenLoader/>
    if (!docInfo?.canRead || !docInfo.path) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <>
            <StickiesBoard ownerId={ownerId} path={docInfo.path} canWrite={docInfo.canWrite}
                           chatFolderId={chatFolderId}
                           onAccessDialogOpen={handleAccessDialogOpen}/>
            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={docInfo.path}
            />
        </>
    );
}
