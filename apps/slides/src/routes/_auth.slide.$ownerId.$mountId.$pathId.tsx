import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useLayout} from '@workspace/ui/components/layout/app/layout-context';
import {AccessDenied, LoadingState} from '@workspace/ui';
import {SlideEditor} from '../components/slides/editor';
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
});

function SlideView() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {setDocumentTitle} = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path?.name?.replace(/\.eigen\w+$/, '') || '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    const path = useMemo(() => docInfo?.path ? {
        ...docInfo.path,
        mountId,
    } : null, [docInfo?.path, mountId]);

    const canWrite = docInfo?.canWrite ?? false;
    const mediaFolderId = docInfo?.folderContents?.find((f: any) => f.name === 'media')?.id ?? null;

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading) return <LoadingState/>;
    if (!path) return <AccessDenied/>;

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
