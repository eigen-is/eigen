import {createFileRoute} from '@tanstack/react-router';
import {useCollabDocumentInfo} from '@workspace/lib/collab';
import {useApp} from '@workspace/ui/components/layout/app/layout-context.tsx';
import {useEffect} from 'react';
import {Sheet} from 'lucide-react';
import {Column, ColumnLayout} from "@workspace/ui/components/layout";
import {Toolbar} from "@workspace/ui/components/layout/toolbar";

export const Route = createFileRoute('/_auth/sheet/$ownerId/$mountId/$pathId')({
    component: SheetView,
});

function SheetView() {
    const {ownerId, mountId, pathId} = Route.useParams();
    const {setAppName} = useApp();
    const {data: docInfo} = useCollabDocumentInfo(ownerId, mountId, pathId);

    useEffect(() => {
        if (docInfo?.path?.name) {
            const name = docInfo.path.name.replace(/\.eigensheets$/, '');
            setAppName(name);
        }
        return () => setAppName('Sheets');
    }, [docInfo?.path?.name, setAppName]);

    return (
        <ColumnLayout>
            <Column id={"1"} width={"flex"} toolbar={
                <Toolbar><></>
                </Toolbar>}>
                <div className="flex-1 flex items-center justify-center h-full bg-muted">
                    <div className="text-center space-y-4">
                    <Sheet className="h-16 w-16 text-muted-foreground mx-auto"/>
                    <h2 className="text-2xl font-semibold text-muted-foreground">Sheets</h2>
                    <p className="text-muted-foreground">Under construction</p>
                </div>
            </div>
            </Column>
        </ColumnLayout>
    );
}
