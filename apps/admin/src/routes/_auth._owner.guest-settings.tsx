// The admin app's Guest access route. Only the server's owner reaches it. It shows the guest settings page,
// where the owner chooses who may sign in as a guest and when an idle guest account is deleted.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui/components/layout/app';
import { GuestSettingsPage } from '../components/admin/guest-settings';

export const Route = createFileRoute('/_auth/_owner/guest-settings')({
    component: GuestSettingsRoute,
});

function GuestSettingsRoute() {
    return (
        <SettingsPage title="Guest access">
            <GuestSettingsPage />
        </SettingsPage>
    );
}
