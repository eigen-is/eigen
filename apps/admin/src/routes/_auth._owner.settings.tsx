// The admin app's Settings route. Only the server's owner reaches it. It shows the Server settings page, whose
// sections hold the server-wide choices, such as the storage quotas and the landing page's links.

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
