import {createFileRoute} from '@tanstack/react-router'
import {CollaborativeEditor} from '@/components/docs/editor'
import {useDocumentAccess} from '@workspace/lib/docs'
import {usePathInfo} from '@workspace/lib/drive'
import {EigenLoader} from '@workspace/ui'
import {useApp} from '@workspace/ui/components/layout/app-context'
import {useEffect, useState} from 'react'

export const Route = createFileRoute('/_auth/doc/$ownerId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    const {ownerId, pathId} = Route.useParams();
    const {data: access, isLoading} = useDocumentAccess(ownerId, pathId);
    const {data: path, isLoading: pathLoading} = usePathInfo(ownerId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);

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
        <div className="bg-muted flex-1 overflow-hidden">
            <CollaborativeEditor ownerId={ownerId} pathId={pathId} access={access}/>
        </div>
    )
}
