// The Personal info page in Space: the profile other people see, a name and a picture, and below it the
// personal preferences that belong to no single app.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { Separator } from '@workspace/ui/components/separator';
import { PreferencesSection } from '../components/space/preferences-section';
import { ProfileEditor } from '../components/space/profile-editor';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <SettingsPage title="Edit Profile">
            <div className="space-y-8">
                <ProfileEditor />
                <Separator />
                <PreferencesSection />
            </div>
        </SettingsPage>
    );
}
