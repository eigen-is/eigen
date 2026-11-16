// The admin app's Onboarding route. Only the server's owner reaches it. It shows the Onboarding settings page,
// which holds such things as the landing page's waitlist and what a new user starts with.

import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui/components/layout/app';
import { OnboardingSettingsPage } from '../components/admin/onboarding-settings';

export const Route = createFileRoute('/_auth/_owner/onboarding')({
    component: OnboardingRoute,
});

function OnboardingRoute() {
    return (
        <SettingsPage title="Onboarding">
            <OnboardingSettingsPage />
        </SettingsPage>
    );
}
