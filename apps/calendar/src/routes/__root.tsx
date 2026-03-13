import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {CalendarSidebar} from "../components/calendar-sidebar";
import {useCallback, useState} from "react";
import {useCalendars, useSharedCalendars, useUpdateSharedCalendar} from "@workspace/lib/calendar";

interface MyRouterContext {
    auth: AuthContextType
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

    return <AuthenticatedCalendarRoot/>;
}

function AuthenticatedCalendarRoot() {
    const {data: calendars = []} = useCalendars();
    const {data: sharedCalendars = []} = useSharedCalendars();
    const updateSharedCalendar = useUpdateSharedCalendar();

    const [visibleCalendarIds, setVisibleCalendarIds] = useState<Set<string>>(new Set());
    const [visibleSharedIds, setVisibleSharedIds] = useState<Set<string>>(new Set());
    const [initialized, setInitialized] = useState(false);

    if (!initialized && calendars.length > 0) {
        setVisibleCalendarIds(new Set(calendars.map(c => c.id)));
        setVisibleSharedIds(new Set(sharedCalendars.filter(sc => sc.visible).map(sc => sc.id)));
        setInitialized(true);
    }

    const toggleCalendarVisibility = useCallback((calendarId: string) => {
        setVisibleCalendarIds(prev => {
            const next = new Set(prev);
            if (next.has(calendarId)) next.delete(calendarId);
            else next.add(calendarId);
            return next;
        });
    }, []);

    const toggleSharedVisibility = useCallback((sharedId: string) => {
        setVisibleSharedIds(prev => {
            const next = new Set(prev);
            const nowVisible = !next.has(sharedId);
            if (nowVisible) next.add(sharedId);
            else next.delete(sharedId);
            updateSharedCalendar.mutate({id: sharedId, visible: nowVisible});
            return next;
        });
    }, [updateSharedCalendar]);

    return (
        <AppShell
            appName="calendar"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <CalendarSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    visibleCalendarIds={visibleCalendarIds}
                    onToggleCalendarVisibility={toggleCalendarVisibility}
                    visibleSharedCalendarIds={visibleSharedIds}
                    onToggleSharedCalendarVisibility={toggleSharedVisibility}
                />
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: CalendarRoot,
});
