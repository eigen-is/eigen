import { parseOwnerId } from '@workspace/lib/types';
import type { SharedCalendar } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';

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

export function toLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function truncateRRule(rruleStr: string, beforeDate: Date): string {
    const options = RRule.parseString(rruleStr);
    const until = new Date(beforeDate);
    until.setUTCDate(until.getUTCDate() - 1);
    until.setUTCHours(23, 59, 59, 0);
    options.until = until;
    delete options.count;
    const result = new RRule(options).toString();
    return result.replace(/^RRULE:/, '');
}
