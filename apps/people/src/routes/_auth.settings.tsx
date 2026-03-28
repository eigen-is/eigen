import {createFileRoute} from '@tanstack/react-router';
import {Column, ColumnLayout} from '@workspace/ui/components/layout/app/column-layout.tsx';
import {ServerSettingsPage} from '../components/people/server-settings';

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
