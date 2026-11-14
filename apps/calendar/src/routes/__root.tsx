import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import { AppShell } from '@workspace/ui';
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
