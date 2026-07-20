import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { ServerSettingsPage } from '../components/admin/server-settings';

export const Route = createFileRoute('/_auth/settings')({
    component: SettingsRoute,
});

function SettingsRoute() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar" toolbar={<ToolbarTitle>Server Settings</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <ServerSettingsPage />
                </div>
            </Column>
        </ColumnLayout>
    );
}
