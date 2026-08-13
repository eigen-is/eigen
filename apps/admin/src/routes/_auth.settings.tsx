import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { ServerSettingsPage } from '../components/admin/server-settings';

export const Route = createFileRoute('/_auth/settings')({
    component: SettingsRoute,
});

function SettingsRoute() {
    return (
        <SettingsPage title="Server Settings">
            <ServerSettingsPage />
        </SettingsPage>
    );
}
