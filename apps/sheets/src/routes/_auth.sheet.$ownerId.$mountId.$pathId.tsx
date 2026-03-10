import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useApp} from '@workspace/ui/components/layout/app/layout-context.tsx';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {EigenLoader} from '@workspace/ui';
import {SheetEditor} from '../components/sheets/editor';
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog';

export const Route = createFileRoute('/_auth/sheet/$ownerId/$mountId/$pathId')({
    component: SheetView,
});

function SheetView() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        if (docInfo?.path?.name) {
            const name = docInfo.path.name.replace(/\.eigensheets$/, '');
            setAppName(name);
        }
        return () => setAppName(originalAppName);
    }, [docInfo?.path?.name, setAppName, originalAppName]);

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
