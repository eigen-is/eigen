import {createFileRoute} from '@tanstack/react-router';
import {ServerSettingsPage} from '../components/people/server-settings';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/app/column-layout.tsx';

export const Route = createFileRoute('/_auth/settings')({
    component: SettingsRoute,
});

function SettingsRoute() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex">
                <ServerSettingsPage/>
            </Column>
        </ColumnLayout>
    );
}
