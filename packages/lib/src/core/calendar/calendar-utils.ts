// Pure calendar helpers the Calendar app, its cards and the API share: the month and week ranges, the events of one
// day, time zones and an instant's wall time in one, how an event's time and recurrence read, and invitations. It also
// turns an edit of one occurrence into the change saved on the whole series, and cuts a series at a date.

import { RRule } from 'rrule';
import { DEFAULT_CALENDAR_COLOR } from '../../constants/calendar';
import type { Attendee, CalendarEventOccurrence, CalendarItem, EventData, SharedCalendar } from '../../types/calendar';
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

export function getEventsForDay(events: readonly CalendarEventOccurrence[], day: Date): CalendarEventOccurrence[] {
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

// The grid lays events out with local Date getters, so every surface labelling a zone-less event must resolve it here
// too.
export function viewerTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Intl knows no Windows zone name, and dropping one expands an Outlook series in UTC, breaking its wall time at the
// next DST change. Intl reads a zone in any case, so one spelling per zone leaves here and a server's formatters stop
// at the zone count.
export function normalizeTimezone(timezone: string | null | undefined): string | null {
    if (!timezone) return null;
    try {
        return dateFormatter({ timeZone: WINDOWS_ZONES.get(timezone) ?? timezone }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

type LocalComponents = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function utcToLocal(date: Date, tz: string): LocalComponents {
    const parts = dateFormatter({
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24,
        minute: get('minute'),
        second: get('second'),
    };
}

export function localToUtc(
    tz: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): Date {
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetAt = (ms: number): number => {
        const local = utcToLocal(new Date(ms), tz);
        return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - ms;
    };

    let resolved = targetMs - offsetAt(targetMs);
    if (resolved + offsetAt(resolved) !== targetMs) {
        // The first guess landed the other side of a transition: solve again with the offset in effect there.
        const corrected = targetMs - offsetAt(resolved);
        // A wall time the spring-forward gap skips resolves with the pre-transition offset — the later instant.
        if (corrected + offsetAt(corrected) !== targetMs) return new Date(Math.max(resolved, corrected));
        resolved = corrected;
    }

    // RFC 5545 resolves an ambiguous fall-back time to the earlier occurrence. The step back is the day's own shift,
    // because Lord Howe moves 30 minutes.
    const shift = offsetAt(resolved - 86400_000) - offsetAt(resolved + 86400_000);
    const earlier = resolved - shift;
    return new Date(shift > 0 && earlier + offsetAt(earlier) === targetMs ? earlier : resolved);
}

// fallbackTimeZone is explicit because the server's own zone is a lie, so mail written there passes 'UTC'.
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
    calendars: readonly CalendarItem[],
    sharedCalendars?: readonly SharedCalendar[],
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

// CalDAV clients stamp ORGANIZER with their own address, so only a foreign one marks an invitation. A team Home has no
// address, so there only Eigen's organizer stamp does: a member's own event carries the member's address.
export function isInvitationFromOthers(event: { data?: EventData | null }, ownerEmail?: string): boolean {
    const organizer = event.data?.organizer;
    if (!organizer) return false;
    if (!ownerEmail) return !!event.data?.organizerEventId;
    return organizer.email.toLowerCase() !== ownerEmail.toLowerCase();
}

// An empty or absent list on an override means its series' guests, so a guest added to the series later reaches every
// occurrence.
export function heldAttendees(
    override: { data?: EventData | null } | null | undefined,
    series: { data?: EventData | null } | null | undefined,
): Attendee[] {
    return override?.data?.attendees?.length ? override.data.attendees : (series?.data?.attendees ?? []);
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

export function occurrenceDateToString(value: Date): string {
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}`;
}

// rrule spells ordinals by a lookup that stops at the 31st, so a day of the year comes out as "131th".
const ORDINAL_IN_TEXT = /(\d+)(?:st|nd|rd|th)/g;

function ordinalSuffix(n: number): string {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    if (n % 10 === 1) return 'st';
    if (n % 10 === 2) return 'nd';
    if (n % 10 === 3) return 'rd';
    return 'th';
}

// A file's RRULE is untrusted input, so a rule rrule cannot read is printed verbatim rather than swallowed.
export function rruleToText(rrule: string | null): string | null {
    if (!rrule) return null;
    try {
        const text = RRule.fromString(rrule)
            .toText()
            .replace(ORDINAL_IN_TEXT, (_, digits: string) => `${digits}${ordinalSuffix(Number(digits))}`);
        return text[0].toUpperCase() + text.slice(1);
    } catch {
        return rrule;
    }
}

type SeriesEdit = {
    title: string;
    description: string | null;
    location: string | null;
    allDay: boolean;
    startTime: Date;
    endTime: Date;
};

type SeriesEditPatch = {
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
    // A timed series turning all-day restates both bounds: midnight-UTC bounds mean nothing beside the old ones.
    const allDayChanged = edited.allDay !== occurrence.allDay;
    if (allDayChanged) patch.allDay = edited.allDay;
    if (startDelta !== 0 || allDayChanged) patch.startTime = new Date(master.startTime.getTime() + startDelta);
    if (endDelta !== 0 || allDayChanged) patch.endTime = new Date(master.endTime.getTime() + endDelta);
    return patch;
}

// A timed series' UNTIL is an instant every client reads alike: the last second before the cut day starts in its zone,
// else in UTC. Beside an all-day DTSTART, RFC 5545 §3.3.10 makes it the day before the cut as a DATE.
export function truncateRRule(
    rrule: string,
    cutDate: string,
    series: { timezone: string | null; allDay: boolean },
): string {
    const options = RRule.parseString(rrule);
    const day = new Date(`${cutDate}T00:00:00Z`);
    const tz = series.allDay ? null : series.timezone;
    const start = tz ? localToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, 0) : day;
    options.until = new Date(start.getTime() - 1000);
    delete options.count;
    const text = new RRule(options).toString().replace(/^RRULE:/, '');
    return series.allDay ? text.replace(/(UNTIL=\d{8})T\d{6}Z/, '$1') : text;
}
