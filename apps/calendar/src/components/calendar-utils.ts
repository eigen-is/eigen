import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useMemo } from 'react';

export type CalendarOption = {
    id: string;
    name: string;
    color: string;
    ownerId: string;
};

export function resolveCalendarName(sc: SharedCalendar, teams?: { id: string; name: string }[]): string {
    const parsed = parseOwnerId(sc.ownerUserId);
    if (parsed.type === 'team') {
        return teams?.find((t) => t.id === parsed.id)?.name || sc.calendarName;
    }
    return sc.calendarName;
}

export function useCalendarOptions(
    ownerId: string,
    calendars: CalendarItem[],
    sharedCalendars: SharedCalendar[],
    teams?: { id: string; name: string }[],
): CalendarOption[] {
    return useMemo(() => {
        const options: CalendarOption[] = calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, ownerId }));
        for (const sc of sharedCalendars) {
            if (sc.permission === 'write') {
                options.push({
                    id: sc.calendarId,
                    name: resolveCalendarName(sc, teams),
                    color: sc.color || sc.calendarColor,
                    ownerId: sc.ownerUserId,
                });
            }
        }
        return options;
    }, [calendars, sharedCalendars, ownerId, teams]);
}

// All-day events store midnight-UTC bounds with an exclusive end (day after the last day); timed events keep
// the local wall time. See CALENDAR.md § All-Day Events.
export function buildEventTimes(
    allDay: boolean,
    startDate: string,
    endDate: string,
    startTime: string,
    endTime: string,
): { start: Date; end: Date } {
    if (allDay) {
        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        return { start, end };
    }
    return { start: new Date(`${startDate}T${startTime}`), end: new Date(`${endDate}T${endTime}`) };
}
