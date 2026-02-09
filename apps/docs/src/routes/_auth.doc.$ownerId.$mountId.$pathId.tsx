import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {CollaborativeEditor} from '../components/docs/editor'
import {useDocumentAccess} from '@workspace/lib/docs'
import {usePathInfo} from '@workspace/lib/drive'
import {EigenLoader} from '@workspace/ui'
import {useApp} from '@workspace/ui/components/layout/app-context'
import {useCallback, useEffect, useState} from 'react'
import {DriveAccessDialog} from '@workspace/ui/components/layout/drive/drive-access-dialog'
import {DriveDeleteItem} from '@workspace/ui/components/layout/drive/drive-delete-item'

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {data: access, isLoading} = useDocumentAccess(ownerId, mountId, pathId);
    const {data: path, isLoading: pathLoading} = usePathInfo(ownerId, mountId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const navigate = useNavigate();

    // Always call hooks at the top level, before any conditional logic
    useEffect(() => {
        // Only change the app name if we have a valid path
        if (path?.name) {
            setAppName?.(path.name.replace('.eigendoc', ''));
        }

        // Restore original app name when component unmounts
        return () => {
            setAppName?.(originalAppName);
        };
    }, [path, originalAppName, setAppName]);

    const handleAccessDialogOpen = useCallback(() => {
        setAccessDialogOpen(true);
    }, [setAccessDialogOpen]);


    // Handle loading states
    if (isLoading || pathLoading) {
        return <EigenLoader/>
    }

    if (!access?.canRead || !path) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <>
            <div className="bg-muted flex-1 overflow-hidden">
                <CollaborativeEditor path={path} access={access}
                                     onAccessDialogOpen={handleAccessDialogOpen}
                                     onDeleteDialogOpen={setDeleteDialogOpen}/>
            </div>
            <DriveAccessDialog
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={path}
            /><DriveDeleteItem
            path={path}
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            onAfterAction={() => {
                navigate({to: `/`});
            }}
        />
        </>
    )
}
