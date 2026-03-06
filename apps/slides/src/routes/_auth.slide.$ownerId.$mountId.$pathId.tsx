import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useApp} from '@workspace/ui/components/layout/app/layout-context.tsx';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {EigenLoader} from '@workspace/ui';
import {SlideEditor} from '../components/slides/editor';
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
});

function SlideView() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        if (docInfo?.path?.name) {
            const name = docInfo.path.name.replace(/\.eigenslides$/, '');
            setAppName(name);
        }
        return () => setAppName(originalAppName);
    }, [docInfo?.path?.name, setAppName, originalAppName]);

    const path = useMemo(() => docInfo?.path ? {
        ...docInfo.path,
        mountId,
    } : null, [docInfo?.path, mountId]);

    const canWrite = docInfo?.canWrite ?? false;
    const mediaFolderId = docInfo?.folderContents?.find((f: any) => f.name === 'media')?.id ?? null;

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading || !path) {
        return <EigenLoader/>;
    }

    return (
        <>
            <SlideEditor
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                onAccessDialogOpen={handleAccessDialogOpen}
            />
            <DriveAccessDialog
                path={path}
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
            />
        </>
    );
}
