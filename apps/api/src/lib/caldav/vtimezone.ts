// RFC 5545 §3.6.5 — build a VTIMEZONE from Intl offset data so serialized TZIDs carry a definition.
// The zone's UTC transitions are discovered by probing Intl offsets, then compressed to two RRULE
// observances when the DST rule is regular, else emitted one observance per transition.
import { utcToLocal } from '../calendar/recurrence';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;

const pad = (n: number) => n.toString().padStart(2, '0');

type Transition = { at: number; from: number; to: number };
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

// A group is compressible when every transition shares (from, to), month, weekday, wall time, follows one
// "nth weekday" (or "last weekday") pattern, and has exactly one transition per year over a gapless span.
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

    // ical.js returns UTC (0) for instants before the earliest onset, so scan a year early: the last
    // transition before fromYear-01-01 (Nov/Oct of fromYear-1) then anchors the whole requested range.
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
