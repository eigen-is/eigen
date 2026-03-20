import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useLayout} from '@workspace/ui/components/layout/app/layout-context';
import {EigenLoader} from '@workspace/ui';
import {SheetEditor} from '../components/sheets/editor';
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog';

export const Route = createFileRoute('/_auth/sheet/$ownerId/$mountId/$pathId')({
    component: SheetView,
});

function SheetView() {
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

    const handleAccessDialogOpen = useCallback(() => setAccessDialogOpen(true), []);

    if (isLoading || !path) {
        return <EigenLoader/>;
    }

    return (
        <>
            <SheetEditor
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
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
