import { parseOwnerId } from '@workspace/lib/types';
import type { SharedCalendar } from '@workspace/lib/types/calendar';

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
