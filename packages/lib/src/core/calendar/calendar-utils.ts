import { RRule } from 'rrule';
import { DEFAULT_CALENDAR_COLOR } from '../../constants/calendar';
import type { CalendarEventOccurrence, CalendarItem, EventData, SharedCalendar } from '../../types/calendar';
import { dateFormatter, formatDayMonth, formatTime } from '../date';
import { WINDOWS_ZONES } from './windows-zones';

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

export function getEventsForDay(events: CalendarEventOccurrence[], day: Date): CalendarEventOccurrence[] {
    return events.filter((e) => {
        if (e.allDay) {
            const dayUtcMs = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
            const dayEndUtcMs = dayUtcMs + 86400_000;
            return e.startTime.getTime() < dayEndUtcMs && e.endTime.getTime() > dayUtcMs;
        }
        const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        // Next local midnight, not +24h — DST transition days are 23/25 hours long.
        const dayEndMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
        return e.startTime.getTime() < dayEndMs && e.endTime.getTime() > dayStartMs;
    });
}

// The local day, for `<input type="date">`; occurrenceDateToString gives the UTC day that wire values carry.
export function toLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function formatEventTime(event: CalendarEventOccurrence): string {
    if (event.allDay) return '';
    return formatTime(event.startTime);
}

// The grid lays events out with local Date getters, so every surface labelling a zone-less event must resolve it here too.
export function viewerTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Intl knows no Windows zone name, and dropping one expands an Outlook series in UTC, breaking its wall time at the next DST change.
const ZONE_ANSWERS = new Map<string, string | null>();
const MAX_ZONE_ANSWERS = 64;

export function normalizeTimezone(timezone: string | null | undefined): string | null {
    if (!timezone) return null;

    const remembered = ZONE_ANSWERS.get(timezone);
    if (remembered !== undefined) return remembered;

    const candidate = WINDOWS_ZONES.get(timezone) ?? timezone;
    let answer: string | null;
    try {
        dateFormatter({ timeZone: candidate });
        answer = candidate;
    } catch {
        answer = null;
    }

    if (ZONE_ANSWERS.size >= MAX_ZONE_ANSWERS) ZONE_ANSWERS.clear();
    ZONE_ANSWERS.set(timezone, answer);
    return answer;
}

// fallbackTimeZone is explicit: the browser passes viewerTimeZone(), iMIP mail passes 'UTC' because the server's zone is a lie.
export function formatEventWhen(
    start: Date,
    end: Date,
    allDay: boolean,
    timezone: string | null | undefined,
    fallbackTimeZone: string,
): string {
    // An all-day event stores midnight UTC and never converts, so it lands in the day bucket the grid uses.
    const tz = allDay ? 'UTC' : (normalizeTimezone(timezone) ?? fallbackTimeZone);
    const date = (d: Date) => formatDayMonth(d, { weekday: 'long', year: true, timeZone: tz });
    const dayKey = (d: Date) => dateFormatter({ timeZone: tz }).format(d);
    const timeOpts: Intl.DateTimeFormatOptions = {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: tz,
    };

    if (allDay) {
        // All-day endTime is exclusive, so the displayed end date is one day earlier than the stored one.
        const displayEnd = new Date(end.getTime() - 86400_000);
        if (dayKey(start) === dayKey(displayEnd)) return date(start);
        return `${date(start)} – ${date(displayEnd)}`;
    }

    if (dayKey(start) === dayKey(end)) {
        const time = dateFormatter(timeOpts);
        return `${date(start)} · ${time.format(start)} – ${time.format(end)}`;
    }
    const when = (d: Date) => `${date(d)}, ${dateFormatter(timeOpts).format(d)}`;
    return `${when(start)} – ${when(end)}`;
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
    return DEFAULT_CALENDAR_COLOR;
}

export function isFreeBusyEvent(event: CalendarEventOccurrence): boolean {
    return !event.id;
}

export function formatFreeBusyTitle(endTime: Date): string {
    return `Busy until ${formatTime(endTime)}`;
}

// An override carries no rule of its own, so only its link to the master says it belongs to a series.
export function isSeriesOccurrence(event: { rrule: string | null; parentEventId: string | null }): boolean {
    return !!event.rrule || !!event.parentEventId;
}

// CalDAV clients stamp ORGANIZER with their own address, so only a foreign one marks an invitation; a team Home has none.
export function isInvitationFromOthers(event: { data?: EventData | null }, ownerEmail?: string): boolean {
    const organizer = event.data?.organizer;
    if (!organizer) return false;
    return !ownerEmail || organizer.email.toLowerCase() !== ownerEmail.toLowerCase();
}

export function getInviteStatus(event: CalendarEventOccurrence, userEmail?: string): 'pending' | 'declined' | null {
    if (!userEmail || !isInvitationFromOthers(event, userEmail)) return null;
    const attendee = event.data?.attendees?.find((a) => a.email.toLowerCase() === userEmail.toLowerCase());
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

// A file's RRULE is untrusted input, so a rule rrule cannot read is printed verbatim rather than swallowed.
export function rruleToText(rrule: string | null): string | null {
    if (!rrule) return null;
    try {
        return RRule.fromString(rrule).toText();
    } catch {
        return rrule;
    }
}

export type SeriesEdit = {
    title: string;
    description: string | null;
    location: string | null;
    allDay: boolean;
    startTime: Date;
    endTime: Date;
};

export type SeriesEditPatch = {
    title?: string;
    description?: string | null;
    location?: string | null;
    allDay?: boolean;
    startTime?: Date;
    endTime?: Date;
};

// "All events in series" is edited from one occurrence but saved on the master, so what the user changed travels
// as a delta: taking the dialog's own times would drop every occurrence before the one they opened.
export function seriesEditFromOccurrence(
    occurrence: SeriesEdit,
    master: Pick<SeriesEdit, 'startTime' | 'endTime'>,
    edited: SeriesEdit,
): SeriesEditPatch {
    const patch: SeriesEditPatch = {};
    if (edited.title !== occurrence.title) patch.title = edited.title;
    if (edited.description !== occurrence.description) patch.description = edited.description;
    if (edited.location !== occurrence.location) patch.location = edited.location;

    const startDelta = edited.startTime.getTime() - occurrence.startTime.getTime();
    const endDelta = edited.endTime.getTime() - occurrence.endTime.getTime();
    // A timed series turning all-day restates both bounds, because midnight-UTC bounds mean nothing beside the old ones.
    const allDayChanged = edited.allDay !== occurrence.allDay;
    if (allDayChanged) patch.allDay = edited.allDay;
    if (startDelta !== 0 || allDayChanged) patch.startTime = new Date(master.startTime.getTime() + startDelta);
    if (endDelta !== 0 || allDayChanged) patch.endTime = new Date(master.endTime.getTime() + endDelta);
    return patch;
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
