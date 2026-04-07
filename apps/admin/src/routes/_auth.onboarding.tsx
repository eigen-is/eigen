import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { OnboardingSettingsPage } from '../components/admin/onboarding-settings';

export const Route = createFileRoute('/_auth/onboarding')({
    component: OnboardingRoute,
});

function OnboardingRoute() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex">
                <div className="h-full overflow-y-auto">
                    <OnboardingSettingsPage />
                </div>
            </Column>
        </ColumnLayout>
    );
}
