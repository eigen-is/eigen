import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { CalendarSidebar } from '../components/calendar-sidebar';

function CalendarRoot() {
    const { user } = useAuth();

    if (!user) {
        return (
            <AppShell appName="calendar" rootRoute={Route}>
                <Outlet />
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="calendar"
            rootRoute={Route}
            sidebar={({ condensed }) => <CalendarSidebar condensed={condensed} />}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: CalendarRoot,
});
