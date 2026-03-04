import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useApp} from '@workspace/ui/components/layout/layout-context';
import {useEffect} from 'react';
import {Sheet} from 'lucide-react';

export const Route = createFileRoute('/_auth/sheet/$ownerId/$mountId/$pathId')({
    component: SheetView,
});

function SheetView() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {setAppName} = useApp();
    const {data: docInfo} = useCollabDocumentInfo(ownerId, mountId, pathId);

    useEffect(() => {
        if (docInfo?.name) {
            const name = docInfo.name.replace(/\.eigensheets$/, '');
            setAppName(name);
        }
        return () => setAppName('Sheets');
    }, [docInfo?.name, setAppName]);

    return (
        <div className="flex flex-col h-full w-full">
            <div className="border-b px-4 py-2 flex items-center gap-2 shrink-0">
                <Sheet className="h-4 w-4 text-muted-foreground"/>
                <span className="text-sm text-muted-foreground">Toolbar</span>
            </div>
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-4">
                    <Sheet className="h-16 w-16 text-muted-foreground mx-auto"/>
                    <h2 className="text-2xl font-semibold text-muted-foreground">Sheets</h2>
                    <p className="text-muted-foreground">Under construction</p>
                </div>
            </div>
        </div>
    );
}
