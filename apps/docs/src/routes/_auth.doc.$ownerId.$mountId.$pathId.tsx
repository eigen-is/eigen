import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {CollaborativeEditor} from '../components/docs/editor'
import {useCollabDocumentInfo} from '@workspace/lib/collab'
import {EigenLoader} from '@workspace/ui'
import {useApp} from '@workspace/ui/components/layout/layout-context'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog'
import {DriveDeleteItem} from '@workspace/ui/components/layout/drive/drive-delete-item'

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const navigate = useNavigate();

    // Always call hooks at the top level, before any conditional logic
    useEffect(() => {
        if (docInfo?.path?.name) {
            setAppName?.(docInfo.path.name.replace('.eigendoc', ''));
        }
        return () => {
            setAppName?.(originalAppName);
        };
    }, [docInfo?.path, originalAppName, setAppName]);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const mediaFolderId = useMemo(() => {
        return docInfo?.folderContents?.find(item => item.name === 'media')?.id ?? null;
    }, [docInfo?.folderContents]);

    // Handle loading states
    if (isLoading) {
        return <EigenLoader/>
    }

    if (!docInfo?.canRead || !docInfo.path) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <>
            <div className="bg-muted flex-1 overflow-hidden">
                <CollaborativeEditor path={docInfo.path} access={docInfo}
                                     mediaFolderId={mediaFolderId}
                                     onAccessDialogOpen={handleAccessDialogOpen}
                                     onDeleteDialogOpen={setDeleteDialogOpen}/>
            </div>
            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={docInfo.path}
            /><DriveDeleteItem
            path={docInfo.path}
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            onAfterAction={() => {
                navigate({to: `/`});
            }}
        />
        </>
    )
}
