import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
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
