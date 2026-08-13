import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui';

export const Route = createFileRoute('/support')({
    component: SupportLayout,
});

function SupportLayout() {
    return (
        <AppShell appName="support" rootRoute={Route}>
            <Outlet />
        </AppShell>
    );
}
