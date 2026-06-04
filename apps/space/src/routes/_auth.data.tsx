import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { DownloadHome } from '../components/space/download-home';

export const Route = createFileRoute('/_auth/data')({
    component: DataExportComponent,
});

function DataExportComponent() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={<ToolbarTitle>Data Export</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <DownloadHome />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
