import { RRule } from 'rrule';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '../../types/calendar';
import { formatTime } from '../date';

export type ViewMode = 'month' | 'week';

export function getMonthRange(date: Date): { from: number; to: number; startDate: Date; endDate: Date } {
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);

    const startDay = firstOfMonth.getDay();
    const startDate = new Date(firstOfMonth);
    startDate.setDate(startDate.getDate() - (startDay === 0 ? 6 : startDay - 1));

    const endDay = lastOfMonth.getDay();
    const endDate = new Date(lastOfMonth);
    if (endDay !== 0) {
        endDate.setDate(endDate.getDate() + (7 - endDay));
    }

    const from = Math.floor(
        new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime() / 1000,
    );
    const to = Math.floor(
        new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59).getTime() / 1000,
    );

    return { from, to, startDate, endDate };
}

export function getWeekRange(date: Date): { from: number; to: number; startDate: Date; endDate: Date } {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const startDate = new Date(d);
    startDate.setDate(d.getDate() - diff);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    const from = Math.floor(startDate.getTime() / 1000);
    const to = Math.floor(endDate.getTime() / 1000);

    return { from, to, startDate, endDate };
}

export function getDaysInRange(startDate: Date, endDate: Date): Date[] {
    const days: Date[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
        days.push(new Date(current));
        current.setDate(current.getDate() + 1);
    }
    return days;
}

export function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(date: Date): boolean {
    return isSameDay(date, new Date());
}

export function getEventsForDay(events: CalendarEventOccurrence[], day: Date): CalendarEventOccurrence[] {
    return events.filter((e) => {
        if (e.allDay) {
            const dayUtcMs = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
            const dayEndUtcMs = dayUtcMs + 86400_000;
            return e.startTime.getTime() < dayEndUtcMs && e.endTime.getTime() > dayUtcMs;
        }
        const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        const dayEndMs = dayStartMs + 86400_000;
        return e.startTime.getTime() < dayEndMs && e.endTime.getTime() > dayStartMs;
    });
}

// Local-time calendar day (YYYY-MM-DD). Used for <input type="date"> values where the
// user's local calendar day is what's shown/edited. Contrast with occurrenceDateToString,
// which derives the UTC day for occurrence/wire values (all-day events are midnight UTC).
export function toISODateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function formatEventTime(event: CalendarEventOccurrence): string {
    if (event.allDay) return '';
    return formatTime(event.startTime);
}

export function getCalendarColor(
    event: CalendarEventOccurrence,
    calendars: CalendarItem[],
    sharedCalendars?: SharedCalendar[],
): string {
    if (event.data?.color) return event.data.color;
    const cal = calendars.find((c) => c.id === event.calendarId);
    if (cal) return cal.color;
    if (sharedCalendars) {
        const sc = sharedCalendars.find((s) => s.calendarId === event.calendarId);
        if (sc) return sc.color || sc.calendarColor;
    }
    return '#4285f4';
}

export function isFreeBusyEvent(event: CalendarEventOccurrence): boolean {
    return !event.id;
}

export function formatFreeBusyTitle(endTime: Date): string {
    return `Busy until ${formatTime(endTime)}`;
}

export function getInviteStatus(event: CalendarEventOccurrence, userEmail?: string): 'pending' | 'declined' | null {
    if (!event.data?.organizer || !userEmail) return null;
    const attendee = event.data.attendees?.find((a) => a.email.toLowerCase() === userEmail.toLowerCase());
    if (!attendee) return null;
    if (attendee.status === 'declined') return 'declined';
    if (attendee.status === 'pending') return 'pending';
    return null;
}

export const WEEKDAY_HEADERS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function parseOccurrenceDate(value: unknown): Date {
    if (value instanceof Date) return value;
    const str = String(value);
    if (str.length === 10) return new Date(`${str}T00:00:00Z`);
    return new Date(str);
}

export function occurrenceDateToString(value: unknown): string {
    if (value instanceof Date) {
        return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
    }
    return String(value).substring(0, 10);
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
