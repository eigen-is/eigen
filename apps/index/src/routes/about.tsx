// The layout route of the public site's About pages: the app shell, named about, around the overview and every app's
// page.

import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app';

export const Route = createFileRoute('/about')({
    component: AboutLayout,
});

function AboutLayout() {
    return (
        <AppShell appName="about" rootRoute={Route}>
            <Outlet />
        </AppShell>
    );
}
