// Which days a Calendar view shows. A view is a mode, such as week, month or schedule, and a focused local day,
// both read from the app's URL. From them come the days to draw, the range the event query asks for, the day an
// arrow steps to, and the toolbar's title. The Calendar app's routes, toolbar and sidebar use it, and so do the links
// into Calendar from other apps, such as an invitation in Mail.

import { getCalendarAppUrl } from '../api';
import { dateFormatter, formatDayMonth, formatMonth } from '../date';
import { toLocalDateString } from './calendar-utils';

export const CALENDAR_VIEW_MODES = ['day', '3day', 'week', 'month', 'schedule'] as const;

export type CalendarViewMode = (typeof CALENDAR_VIEW_MODES)[number];

export const CALENDAR_VIEW_LABELS: Record<CalendarViewMode, string> = {
    day: 'Day',
    '3day': '3 days',
    week: 'Week',
    month: 'Month',
    schedule: 'Schedule',
};

const SCHEDULE_DAYS = 28;

// Numbered as Date.getDay() numbers weekdays.
export const WEEK_STARTS_ON = 1;

// Any week will do: the headers follow WEEK_STARTS_ON through viewDays.
export const WEEKDAY_HEADERS = viewDays('week', new Date(2026, 0, 1)).map(weekdayHeader);

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarViewMode(value: string): value is CalendarViewMode {
    return CALENDAR_VIEW_MODES.some((mode) => mode === value);
}

// A day key comes from a URL, so a malformed or impossible day, such as 30 February, reads as null.
export function parseDayKey(key: string): Date | null {
    const match = DAY_KEY.exec(key);
    if (!match) return null;
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return toLocalDateString(day) === key ? day : null;
}

export function viewDays(mode: CalendarViewMode, focus: Date): Date[] {
    if (mode === 'day') return daysFrom(focus, 1);
    if (mode === '3day') return daysFrom(focus, 3);
    if (mode === 'week') return daysFrom(startOfWeek(focus), 7);
    if (mode === 'schedule') return daysFrom(focus, SCHEDULE_DAYS);
    const first = startOfWeek(new Date(focus.getFullYear(), focus.getMonth(), 1));
    const last = new Date(focus.getFullYear(), focus.getMonth() + 1, 0);
    const weeks = Math.ceil((dayNumber(last) - dayNumber(first) + 1) / 7);
    return daysFrom(first, weeks * 7);
}

export function weekdayHeader(day: Date): string {
    return dateFormatter({ weekday: 'short' }).format(day).toUpperCase();
}

// Unix seconds, from the first day's midnight to the last second of the last day.
export function viewRange(mode: CalendarViewMode, focus: Date): { from: number; to: number } {
    const days = viewDays(mode, focus);
    const end = addDays(days[days.length - 1], 1);
    return { from: days[0].getTime() / 1000, to: end.getTime() / 1000 - 1 };
}

export function stepFocus(mode: CalendarViewMode, focus: Date, dir: 1 | -1): Date {
    if (mode === 'day') return addDays(focus, dir);
    if (mode === '3day') return addDays(focus, 3 * dir);
    if (mode === 'week') return addDays(focus, 7 * dir);
    if (mode === 'schedule') return addDays(focus, SCHEDULE_DAYS * dir);
    const lastOfTarget = new Date(focus.getFullYear(), focus.getMonth() + dir + 1, 0).getDate();
    return new Date(focus.getFullYear(), focus.getMonth() + dir, Math.min(focus.getDate(), lastOfTarget));
}

export function viewTitle(mode: CalendarViewMode, focus: Date): string {
    if (mode === 'month') return `${formatMonth(focus, 'long')} ${focus.getFullYear()}`;
    if (mode === 'day') return formatDayMonth(focus, { weekday: 'long', year: true });
    const days = viewDays(mode, focus);
    const first = days[0];
    const last = days[days.length - 1];
    if (first.getFullYear() !== last.getFullYear()) {
        return `${formatDayMonth(first, { year: true })} – ${formatDayMonth(last, { year: true })}`;
    }
    if (first.getMonth() !== last.getMonth()) {
        return `${formatDayMonth(first)} – ${formatDayMonth(last, { year: true })}`;
    }
    return `${first.getDate()} – ${formatDayMonth(last, { year: true })}`;
}

// Calendar's start page picks the view for the device, so a link from another app names only the day.
export function calendarEventLink({ date, eventId }: { date: Date; eventId: string }): string {
    return getCalendarAppUrl(`?date=${toLocalDateString(date)}&eventId=${encodeURIComponent(eventId)}`);
}

// Through the Date constructor, not milliseconds, so a DST day of 23 or 25 hours still steps one calendar day.
function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date): Date {
    return addDays(date, -((date.getDay() - WEEK_STARTS_ON + 7) % 7));
}

function daysFrom(first: Date, count: number): Date[] {
    return Array.from({ length: count }, (_, i) => addDays(first, i));
}

// A day count that ignores DST, for the number of days between two local dates.
function dayNumber(date: Date): number {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400_000;
}
