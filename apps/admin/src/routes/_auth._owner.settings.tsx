// The admin app's Settings route. Only the server's owner reaches it, and it shows the server settings page.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { ServerSettingsPage } from '../components/admin/server-settings';

export const Route = createFileRoute('/_auth/_owner/settings')({
    component: SettingsRoute,
});

function SettingsRoute() {
    return (
        <SettingsPage title="Server settings">
            <ServerSettingsPage />
        </SettingsPage>
    );
}
