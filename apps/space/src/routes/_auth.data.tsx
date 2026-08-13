import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui/components/layout/app/settings-page';
import { DownloadHome } from '../components/space/download-home';

export const Route = createFileRoute('/_auth/data')({
    component: DataExportComponent,
});

function DataExportComponent() {
    return (
        <SettingsPage title="Data Export">
            <DownloadHome />
        </SettingsPage>
    );
}
