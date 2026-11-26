// Space's Change password page: a settings page around the password form, which sends the change and returns to
// Space's start page when it is done.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui/components/layout/app';
import { ChangePassword } from '../components/space/change-password';

export const Route = createFileRoute('/_auth/security/password')({
    component: PasswordComponent,
});

function PasswordComponent() {
    return (
        <SettingsPage title="Change password">
            <ChangePassword />
        </SettingsPage>
    );
}
