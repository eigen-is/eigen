// A VTIMEZONE both ways. buildVTimezone writes one from Intl offset data for a zone Eigen names, so a strict parser
// doesn't read its wall times as floating (RFC 5545 §3.6.5); the iCalendar writer adds it to a resource.
// vtimezoneOffset reads the offset a file's own zone states at a wall time, for a TZID no name resolves, such as
// Outlook's "Customized Time Zone"; the parser calls it for every such time.

import { utcToLocal } from '@workspace/lib/calendar/calendar-utils';
import ICAL from 'ical.js';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;
// A zone a person or Outlook writes states a few observances; one with more reads as its standard time.
const MAX_OBSERVANCES = 16;

type Kind = 'DAYLIGHT' | 'STANDARD';
type Transition = { at: number; from: number; to: number };
type WallInfo = { year: number; month: number; weekday: number; nth: number; isLast: boolean; timeOfDay: string };
type Onset = { at: number; offset: number };

const tznameFormatters = new Map<string, Intl.DateTimeFormat>();
// The last block built per zone, so it holds one entry per zone. Returned by reference: callers must not mutate it.
const builtBlocks = new Map<string, { years: string; lines: string[] }>();

export function buildVTimezone(tzid: string, fromYear: number, toYear: number): string[] {
    const years = `${fromYear}-${toYear}`;
    const built = builtBlocks.get(tzid);
    if (built?.years === years) return built.lines;

    // A parser such as ical.js reads UTC before a zone's earliest onset, so the scan starts a year early.
    const scanStart = Date.UTC(fromYear - 1, 0, 1);
    const transitions = scanTransitions(tzid, scanStart, Date.UTC(toYear + 1, 0, 1));

    const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];
    const daylight = compressGroup(tzid, 'DAYLIGHT', transitions);
    const standard = compressGroup(tzid, 'STANDARD', transitions);
    if (transitions.length === 0) {
        const offset = offsetMinutes(tzid, new Date(scanStart));
        lines.push(...observance('STANDARD', offset, offset, tzid, new Date(scanStart), '19700101T000000'));
    } else if (daylight && standard) {
        const [earlier, later] = daylight.at <= standard.at ? [daylight, standard] : [standard, daylight];
        lines.push(...earlier.lines, ...later.lines);
    } else {
        for (const transition of transitions) {
            const kind = transition.to > transition.from ? 'DAYLIGHT' : 'STANDARD';
            const dtstart = formatWallClock(new Date(transition.at + transition.from * 60_000));
            lines.push(...observance(kind, transition.from, transition.to, tzid, new Date(transition.at), dtstart));
        }
    }

    lines.push('END:VTIMEZONE');
    builtBlocks.set(tzid, { years, lines });
    return lines;
}

function scanTransitions(tzid: string, startMs: number, endMs: number): Transition[] {
    const transitions: Transition[] = [];
    let previous = offsetMinutes(tzid, new Date(startMs));
    for (let t = startMs + DAY_MS; t <= endMs; t += DAY_MS) {
        const offset = offsetMinutes(tzid, new Date(t));
        if (offset === previous) continue;
        // Narrow the crossing day to the first minute carrying the new offset (transitions land on minutes).
        let lo = (t - DAY_MS) / 60_000;
        let hi = t / 60_000;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (offsetMinutes(tzid, new Date(mid * 60_000)) === previous) lo = mid;
            else hi = mid;
        }
        transitions.push({ at: hi * 60_000, from: previous, to: offset });
        previous = offset;
    }
    return transitions;
}

function offsetMinutes(tzid: string, instant: Date): number {
    const local = utcToLocal(instant, tzid);
    const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    return Math.round((wall - instant.getTime()) / 60_000);
}

// One open-ended yearly observance for a kind's transitions, when all fall on one weekday of one month at one time.
function compressGroup(tzid: string, kind: Kind, transitions: Transition[]): { at: number; lines: string[] } | null {
    const group = transitions.filter((t) => (kind === 'DAYLIGHT' ? t.to > t.from : t.to < t.from));
    const [first] = group;
    if (!first) return null;
    const walls = group.map(wallInfo);
    const [firstWall] = walls;
    const alike = group.every((transition) => transition.from === first.from && transition.to === first.to);
    const sameDay = walls.every(
        (w) => w.month === firstWall.month && w.weekday === firstWall.weekday && w.timeOfDay === firstWall.timeOfDay,
    );
    if (!alike || !sameDay) return null;

    const years = walls.map((w) => w.year);
    if (new Set(years).size !== years.length) return null;
    if (Math.max(...years) - Math.min(...years) + 1 !== years.length) return null;

    let byday: string;
    if (walls.every((w) => w.isLast)) byday = `-1${WEEKDAYS[firstWall.weekday]}`;
    else if (walls.every((w) => w.nth === firstWall.nth)) byday = `${firstWall.nth}${WEEKDAYS[firstWall.weekday]}`;
    else return null;

    const rrule = `FREQ=YEARLY;BYMONTH=${firstWall.month};BYDAY=${byday}`;
    const dtstart = formatWallClock(new Date(first.at + first.from * 60_000));
    return { at: first.at, lines: observance(kind, first.from, first.to, tzid, new Date(first.at), dtstart, rrule) };
}

// DTSTART is the transition moment expressed in the pre-transition offset.
function wallInfo(transition: Transition): WallInfo {
    const shifted = new Date(transition.at + transition.from * 60_000);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
        year,
        month,
        weekday: shifted.getUTCDay(),
        nth: Math.ceil(day / 7),
        isLast: day > daysInMonth - 7,
        timeOfDay: formatWallClock(shifted).slice(9),
    };
}

// The UTC fields of a Date already shifted into the target wall clock, as YYYYMMDDTHHMMSS.
function formatWallClock(shifted: Date): string {
    return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())}`;
}

function observance(
    kind: Kind,
    from: number,
    to: number,
    tzid: string,
    after: Date,
    dtstart: string,
    rrule?: string,
): string[] {
    const lines = [
        `BEGIN:${kind}`,
        `TZOFFSETFROM:${formatOffset(from)}`,
        `TZOFFSETTO:${formatOffset(to)}`,
        `TZNAME:${tzName(tzid, after)}`,
        `DTSTART:${dtstart}`,
    ];
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push(`END:${kind}`);
    return lines;
}

function formatOffset(minutes: number): string {
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function pad(n: number): string {
    return n.toString().padStart(2, '0');
}

function tzName(tzid: string, instant: Date): string {
    let formatter = tznameFormatters.get(tzid);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'short' });
        tznameFormatters.set(tzid, formatter);
    }
    return formatter.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value ?? tzid;
}

// ical.js walks a zone's observance rules from their DTSTART, however far back that is, so a zone only the file
// defines is read here instead: the observance whose latest onset by this wall time came last gives the offset.
export function vtimezoneOffset(vtimezone: ICAL.Component, wall: number): number {
    const observances = vtimezone.getAllSubcomponents();
    const head = observances.slice(0, MAX_OBSERVANCES);
    const standard = head.find((observance) => observance.name === 'standard') ?? head[0];
    const fixed = (standard && offsetSeconds(standard, 'tzoffsetto')) ?? 0;
    if (observances.length > MAX_OBSERVANCES) return fixed;
    let latest: Onset = { at: -Infinity, offset: fixed };
    for (const observance of observances) {
        const onset = latestOnset(observance, wall);
        if (!onset) return fixed;
        if (onset.at > latest.at) latest = onset;
    }
    return latest.offset;
}

function offsetSeconds(observance: ICAL.Component, name: string): number | null {
    const value = observance.getFirstPropertyValue(name);
    return value instanceof ICAL.UtcOffset ? value.toSeconds() : null;
}

// In wall-clock milliseconds, at -Infinity before the first onset; null for a rule in no shape a real zone uses.
function latestOnset(observance: ICAL.Component, wall: number): Onset | null {
    const start = observance.getFirstPropertyValue('dtstart');
    const rule = observance.getFirstPropertyValue('rrule');
    const from = offsetSeconds(observance, 'tzoffsetfrom');
    const offset = offsetSeconds(observance, 'tzoffsetto');
    if (!(start instanceof ICAL.Time) || observance.hasProperty('rdate')) return null;
    if (from === null || offset === null) return null;
    const timeOfDay = ((start.hour * 60 + start.minute) * 60 + start.second) * 1000;
    const first = Date.UTC(start.year, start.month - 1, start.day) + timeOfDay;
    const until =
        rule instanceof ICAL.Recur && rule.until
            ? Date.UTC(rule.until.year, rule.until.month - 1, rule.until.day + 1)
            : Infinity;
    // A wall time the spring-forward gap skips keeps the offset before it (RFC 5545 §3.3.5).
    const passed = (at: number) => at >= first && at < until && wall >= at + Math.max(0, offset - from) * 1000;
    if (!rule) return { at: passed(first) ? first : -Infinity, offset };
    if (!(rule instanceof ICAL.Recur)) return null;
    const year = new Date(wall).getUTCFullYear();
    for (const day of [onsetDay(rule, start, year), onsetDay(rule, start, year - 1)]) {
        if (day === null) return null;
        if (passed(day + timeOfDay)) return { at: day + timeOfDay, offset };
    }
    return { at: -Infinity, offset };
}

// Midnight of the one day a yearly rule of one BYMONTH and one BYDAY names in a year. A BYMONTHDAY may narrow it, and a
// BYHOUR, BYMINUTE or BYSECOND may repeat the observance's start time.
function onsetDay(rule: ICAL.Recur, start: ICAL.Time, year: number): number | null {
    const { BYMONTH, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE, BYSECOND, ...rest } = rule.parts;
    const at = (part: number[] | undefined, value: number) => !part || (part.length === 1 && part[0] === value);
    if (!at(BYHOUR, start.hour) || !at(BYMINUTE, start.minute) || !at(BYSECOND, start.second)) return null;
    const byday = BYDAY?.length === 1 ? /^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.exec(BYDAY[0]) : null;
    const month = BYMONTH?.length === 1 ? BYMONTH[0] : 0;
    if (rule.freq !== 'YEARLY' || rule.interval !== 1 || rule.count || !month || !byday) return null;
    if (Object.keys(rest).length) return null;
    const first = 1 + ((WEEKDAYS.indexOf(byday[2]) - new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 7) % 7);
    const count = Math.floor((new Date(Date.UTC(year, month, 0)).getUTCDate() - first) / 7) + 1;
    const days = Array.from({ length: count }, (_, i) => first + 7 * i);
    const nth = Number(byday[1] ?? 0);
    const named = nth ? [days.at(nth > 0 ? nth - 1 : nth)] : days;
    const hits = named.filter((day) => day !== undefined && (!BYMONTHDAY || BYMONTHDAY.includes(day)));
    return hits.length === 1 ? Date.UTC(year, month - 1, hits[0]) : null;
}
