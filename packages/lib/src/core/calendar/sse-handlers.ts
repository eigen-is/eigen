import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {toast} from 'sonner';
import {calendarKeys} from './hooks/use-calendar';
import {homeKeys} from '../home';

function invalidateAllCalendar(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.all});
    queryClient.invalidateQueries({queryKey: homeKeys.all});
}

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('calendar:')) return false;

    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_UPDATED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_DELETED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_CREATED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_UPDATED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_DELETED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_SHARED:
            invalidateAllCalendar(queryClient);
            if ('calendarShare' in event) toast('Calendar shared', {description: `"${event.calendarShare.calendarName}" was shared with you`});
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateAllCalendar(queryClient);
            if ('calendarShare' in event) toast('Calendar unshared', {description: `"${event.calendarShare.calendarName}" is no longer shared with you`});
            return true;

        case SSEventType.CALENDAR_INVITE_RECEIVED:
            invalidateAllCalendar(queryClient);
            if ('calendar' in event && event.calendar.title) toast('New invitation', {description: event.calendar.title});
            return true;

        case SSEventType.CALENDAR_INVITE_UPDATED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_INVITE_CANCELLED:
            invalidateAllCalendar(queryClient);
            return true;

        case SSEventType.CALENDAR_INVITE_RSVP:
            invalidateAllCalendar(queryClient);
            return true;

        default:
            return false;
    }
}
