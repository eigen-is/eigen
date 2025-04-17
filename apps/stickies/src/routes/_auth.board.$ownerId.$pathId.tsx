import {createFileRoute} from '@tanstack/react-router'
import {useDocumentAccess} from '@workspace/lib/docs'
import {usePathInfo} from '@workspace/lib/drive'
import {EigenLoader} from '@workspace/ui'
import {useApp} from '@workspace/ui/components/layout/app-context'
import {useEffect, useState} from 'react'
import {StickiesBoard} from "@/components/dnd-board/board.tsx";

export const Route = createFileRoute('/_auth/board/$ownerId/$pathId')({
    component: StickiesRoute,
})

function StickiesRoute() {
    const {ownerId, pathId} = Route.useParams();
    const {data: access, isLoading} = useDocumentAccess(ownerId, pathId);
    const {data: path, isLoading: pathLoading} = usePathInfo(ownerId, pathId);
    const {appName, setAppName} = useApp();
    const [originalAppName] = useState(appName);

    useEffect(() => {
        if (path?.name) setAppName?.(path.name.replace('.eigenstickies', ''));
        return () => setAppName?.(originalAppName);
    }, [path, originalAppName, setAppName]);

    if (isLoading || pathLoading) return <EigenLoader />
    if (!access?.canRead || !path) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">Encountering the null vector: a rendezvous with nothing at all.</p>
            </div>
        );
    }

    return (
        <StickiesBoard ownerId={ownerId} pathId={pathId} canWrite={access.canWrite} />
    );
}
