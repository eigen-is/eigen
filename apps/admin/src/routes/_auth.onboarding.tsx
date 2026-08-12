import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@workspace/ui/components/layout/app/settings-page.tsx';
import { OnboardingSettingsPage } from '../components/admin/onboarding-settings';

export const Route = createFileRoute('/_auth/onboarding')({
    component: OnboardingRoute,
});

function OnboardingRoute() {
    return (
        <SettingsPage title="Onboarding">
            <OnboardingSettingsPage />
        </SettingsPage>
    );
}
