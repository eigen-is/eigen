// The Personal info page in Space: the profile other people see, a name and a picture. Its title matches its
// link in Space's nav, and ProfileEditor does the editing.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { ProfileEditor } from '../components/space/profile-editor';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <SettingsPage title="Personal info">
            <ProfileEditor />
        </SettingsPage>
    );
}
