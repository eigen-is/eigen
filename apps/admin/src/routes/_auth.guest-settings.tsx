import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { GuestSettingsPage } from '../components/admin/guest-settings';

export const Route = createFileRoute('/_auth/guest-settings')({
    component: GuestSettingsRoute,
});

function GuestSettingsRoute() {
    return (
        <SettingsPage title="Guest access">
            <GuestSettingsPage />
        </SettingsPage>
    );
}
