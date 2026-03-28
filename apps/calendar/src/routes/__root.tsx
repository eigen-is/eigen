import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';
import {type AuthContextType, useAuth} from '@workspace/lib/auth';
import {AppShell} from '@workspace/ui/components/layout/app/app-shell.tsx';
import {CalendarSidebar} from '../components/calendar-sidebar';

interface MyRouterContext {
    auth: AuthContextType;
}

function CalendarRoot() {
    const {user} = useAuth();

    if (!user) {
        return (
            <AppShell appName="calendar" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="calendar"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <CalendarSidebar condensed={condensed} isMobile={isMobile} onClose={onClose}/>
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: CalendarRoot,
});
