// Space's Data export page, where the user will download a copy of everything they keep in Eigen. The export is
// not built yet, so DownloadHome shows its button disabled with a line that says so.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { DownloadHome } from '../components/space/download-home';

export const Route = createFileRoute('/_auth/data')({
    component: DataExportComponent,
});

function DataExportComponent() {
    return (
        <SettingsPage title="Data export">
            <DownloadHome />
        </SettingsPage>
    );
}
