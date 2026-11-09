// A VTIMEZONE both ways. buildVTimezone writes one from Intl offset data for a zone Eigen names, so a strict parser
// doesn't read its wall times as floating (RFC 5545 §3.6.5); the iCalendar writer adds it to a resource.
// vtimezoneOffset reads the offset a file's own zone states at a wall time, for a TZID no name resolves, such as
// Outlook's "Customized Time Zone"; the parser calls it for every such time.

import ICAL from 'ical.js';
import { utcToLocal } from './wall-clock';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;
// A zone a person or Outlook writes states a few observances; one with more reads as its standard time.
const MAX_OBSERVANCES = 16;

const pad = (n: number) => n.toString().padStart(2, '0');

type Transition = { at: number; from: number; to: number };
type Onset = { at: number; offset: number };
type WallInfo = {
    year: number;
    monthNum: number;
    weekday: number;
    nth: number;
    isLast: boolean;
    tod: string;
    dtstart: string;
};

const tznameCache = new Map<string, Intl.DateTimeFormat>();
// Entries are returned by reference — callers must not mutate them.
const resultCache = new Map<string, string[]>();

function offsetMinutes(tzid: string, instant: Date): number {
    const l = utcToLocal(instant, tzid);
    return Math.round((Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - instant.getTime()) / 60_000);
}

function formatOffset(minutes: number): string {
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// Read the UTC fields of a Date already shifted into the target wall clock as YYYYMMDDTHHMMSS.
function formatWallClock(shifted: Date): string {
    return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())}`;
}

function tzName(tzid: string, instant: Date): string {
    let fmt = tznameCache.get(tzid);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'short' });
        tznameCache.set(tzid, fmt);
    }
    return fmt.formatToParts(instant).find((p) => p.type === 'timeZoneName')!.value;
}

function scanTransitions(tzid: string, startMs: number, endMs: number): Transition[] {
    const transitions: Transition[] = [];
    let prev = offsetMinutes(tzid, new Date(startMs));
    for (let t = startMs + DAY_MS; t <= endMs; t += DAY_MS) {
        const off = offsetMinutes(tzid, new Date(t));
        if (off === prev) continue;
        // Narrow the crossing day to the first minute carrying the new offset (transitions land on minutes).
        let lo = (t - DAY_MS) / 60_000;
        let hi = t / 60_000;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (offsetMinutes(tzid, new Date(mid * 60_000)) === prev) lo = mid;
            else hi = mid;
        }
        transitions.push({ at: hi * 60_000, from: prev, to: off });
        prev = off;
    }
    return transitions;
}

function wallInfo(tr: Transition): WallInfo {
    // DTSTART is the transition moment expressed in the pre-transition offset.
    const shifted = new Date(tr.at + tr.from * 60_000);
    const year = shifted.getUTCFullYear();
    const monthNum = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    const dtstart = formatWallClock(shifted);
    return {
        year,
        monthNum,
        weekday: shifted.getUTCDay(),
        nth: Math.ceil(day / 7),
        isLast: day > daysInMonth - 7,
        tod: dtstart.slice(9),
        dtstart,
    };
}

function observance(
    type: 'DAYLIGHT' | 'STANDARD',
    from: number,
    to: number,
    tzid: string,
    after: Date,
    dtstart: string,
    rrule?: string,
): string[] {
    const lines = [
        `BEGIN:${type}`,
        `TZOFFSETFROM:${formatOffset(from)}`,
        `TZOFFSETTO:${formatOffset(to)}`,
        `TZNAME:${tzName(tzid, after)}`,
        `DTSTART:${dtstart}`,
    ];
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push(`END:${type}`);
    return lines;
}

function compressGroup(tzid: string, type: 'DAYLIGHT' | 'STANDARD', group: Transition[]): string[] | null {
    const first = group[0];
    const infos = group.map(wallInfo);
    const w0 = infos[0];

    for (let i = 0; i < group.length; i++) {
        const tr = group[i];
        const w = infos[i];
        if (tr.from !== first.from || tr.to !== first.to) return null;
        if (w.monthNum !== w0.monthNum || w.weekday !== w0.weekday || w.tod !== w0.tod) return null;
    }

    const years = infos.map((w) => w.year);
    if (new Set(years).size !== years.length) return null;
    if (Math.max(...years) - Math.min(...years) + 1 !== years.length) return null;

    let byday: string;
    if (infos.every((w) => w.isLast)) byday = `-1${WEEKDAYS[w0.weekday]}`;
    else if (infos.every((w) => w.nth === w0.nth)) byday = `${w0.nth}${WEEKDAYS[w0.weekday]}`;
    else return null;

    const rrule = `FREQ=YEARLY;BYMONTH=${w0.monthNum};BYDAY=${byday}`;
    return observance(type, first.from, first.to, tzid, new Date(first.at), w0.dtstart, rrule);
}

function observanceFor(tzid: string, tr: Transition): string[] {
    const type = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
    return observance(type, tr.from, tr.to, tzid, new Date(tr.at), formatWallClock(new Date(tr.at + tr.from * 60_000)));
}

export function buildVTimezone(tzid: string, fromYear: number, toYear: number): string[] {
    const key = `${tzid}|${fromYear}|${toYear}`;
    const cached = resultCache.get(key);
    if (cached) return cached;

    // ical.js reports UTC for instants before the earliest onset, so the scan starts a year early to anchor the range.
    const scanStart = Date.UTC(fromYear - 1, 0, 1);
    const transitions = scanTransitions(tzid, scanStart, Date.UTC(toYear + 1, 0, 1));

    const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

    if (transitions.length === 0) {
        const off = offsetMinutes(tzid, new Date(scanStart));
        lines.push(...observance('STANDARD', off, off, tzid, new Date(scanStart), '19700101T000000'));
    } else {
        const daylight = transitions.filter((t) => t.to > t.from);
        const standard = transitions.filter((t) => t.to < t.from);
        const compDaylight = daylight.length ? compressGroup(tzid, 'DAYLIGHT', daylight) : null;
        const compStandard = standard.length ? compressGroup(tzid, 'STANDARD', standard) : null;

        if (compDaylight && compStandard) {
            const daylightFirst = daylight[0].at <= standard[0].at;
            lines.push(...(daylightFirst ? [...compDaylight, ...compStandard] : [...compStandard, ...compDaylight]));
        } else {
            for (const tr of transitions) lines.push(...observanceFor(tzid, tr));
        }
    }

    lines.push('END:VTIMEZONE');
    resultCache.set(key, lines);
    return lines;
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
    for (const day of [onsetDay(rule, year), onsetDay(rule, year - 1)]) {
        if (day === null) return null;
        if (passed(day + timeOfDay)) return { at: day + timeOfDay, offset };
    }
    return { at: -Infinity, offset };
}

// Midnight of the one day a yearly rule of one BYMONTH and one BYDAY, and optionally BYMONTHDAY, names in a year.
function onsetDay(rule: ICAL.Recur, year: number): number | null {
    const { BYMONTH, BYDAY, BYMONTHDAY, ...rest } = rule.parts;
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
