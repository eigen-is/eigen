// Calendar's root route: the app shell around every Calendar page. Anyone signed in gets the Calendar sidebar
// beside the page, and a signed-out visitor, such as on the login page, only the shell.

import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import { AppShell } from '@workspace/ui/components/layout/app';
import { CalendarSidebar } from '../components/calendar-sidebar';

function CalendarRoot() {
    const { user } = useAuth();

    return (
        <AppShell
            appName="calendar"
            rootRoute={Route}
            sidebar={user ? ({ condensed }) => <CalendarSidebar condensed={condensed} /> : undefined}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: CalendarRoot,
});
