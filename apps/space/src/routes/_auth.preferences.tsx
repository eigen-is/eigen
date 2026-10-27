// The Preferences page in Space: the personal choices that belong to no single app, such as the theme,
// which every app reads from the personal settings.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui';
import { PreferencesSection } from '../components/space/preferences-section';

export const Route = createFileRoute('/_auth/preferences')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <SettingsPage title="Preferences">
            <PreferencesSection />
        </SettingsPage>
    );
}
