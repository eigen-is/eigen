import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { GuestSettingsPage } from '../components/admin/guest-settings';

export const Route = createFileRoute('/_auth/guest-settings')({
    component: GuestSettingsRoute,
});

function GuestSettingsRoute() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex">
                <div className="h-full overflow-y-auto">
                    <GuestSettingsPage />
                </div>
            </Column>
        </ColumnLayout>
    );
}
