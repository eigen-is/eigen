// Which days a Calendar view shows. A view is a mode, such as week, month or schedule, and a focused local day,
// both read from the app's URL. From them come the days to draw, the range the event query asks for, the day an
// arrow steps to, and the toolbar's title. It serves the Calendar app, such as its toolbar, and the links into Calendar
// from other apps, such as an invitation in Mail.

import type { CalendarViewMode } from '@workspace/lib/types/calendar';
import { CALENDAR_VIEW_MODES } from '@workspace/lib/types/calendar';
import { getCalendarAppUrl } from '../api';
import { dateFormatter, formatDayMonth, formatMonth } from '../date';
import { addDays, toLocalDateString } from './calendar-utils';

export const CALENDAR_VIEW_LABELS: Record<CalendarViewMode, string> = {
    day: 'Day',
    '3day': '3 days',
    week: 'Week',
    month: 'Month',
    schedule: 'Schedule',
};

const VIEW_SPAN: Record<Exclude<CalendarViewMode, 'month'>, number> = { day: 1, '3day': 3, week: 7, schedule: 28 };

// Numbered as Date.getDay() numbers weekdays.
export const WEEK_STARTS_ON = 1;

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
    if (mode === 'week') return daysFrom(startOfWeek(focus), VIEW_SPAN.week);
    if (mode !== 'month') return daysFrom(focus, VIEW_SPAN[mode]);
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
    if (mode !== 'month') return addDays(focus, VIEW_SPAN[mode] * dir);
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
