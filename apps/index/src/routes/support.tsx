// The layout route of the public site's Support pages: the app shell, named support, around the overview, its
// sections and their articles.

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app';

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
