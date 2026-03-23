import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {CollaborativeEditor} from '../components/docs/editor'
import {useCollabDocumentInfo} from '@workspace/lib/collab'
import {AccessDenied, LoadingState} from '@workspace/ui'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {useLayout} from '@workspace/ui/components/layout/app/layout-context'
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog'
import {DriveDeleteItem} from '@workspace/ui/components/layout/drive/drive-delete-item'

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: docInfo, isLoading} = useCollabDocumentInfo(ownerId, mountId, pathId);
    const {setDocumentTitle} = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path?.name?.replace(/\.eigen\w+$/, '') || '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const navigate = useNavigate();

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);

    const mediaFolderId = useMemo(() => {
        return docInfo?.folderContents?.find(item => item.name === 'media')?.id ?? null;
    }, [docInfo?.folderContents]);

    const chatFolderId = useMemo(() => {
        return docInfo?.folderContents?.find(item => item.name === 'chat')?.id ?? null;
    }, [docInfo?.folderContents]);

    if (isLoading) {
        return <LoadingState/>
    }

    if (!docInfo?.canRead || !docInfo.path) {
        return <AccessDenied/>;
    }

    return (
        <>
            <div className="flex-1 overflow-hidden">
                <CollaborativeEditor path={docInfo.path} access={docInfo}
                                     mediaFolderId={mediaFolderId}
                                     chatFolderId={chatFolderId}
                                     onAccessDialogOpen={handleAccessDialogOpen}
                                     onDeleteDialogOpen={setDeleteDialogOpen}/>
            </div>
            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={docInfo.path}
            />
            <DriveDeleteItem
                paths={docInfo.path ? [docInfo.path] : []}
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                onAfterAction={() => {
                    navigate({to: `/`});
                }}
            />
        </>
    )
}
