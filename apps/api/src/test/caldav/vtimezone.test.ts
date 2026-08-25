import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { buildVTimezone } from '../../lib/caldav/vtimezone';
import { utcToLocal } from '../../lib/calendar/recurrence';

const count = (lines: string[], line: string) => lines.filter((l) => l === line).length;

function block(lines: string[], type: 'DAYLIGHT' | 'STANDARD'): string[] {
    return lines.slice(lines.indexOf(`BEGIN:${type}`), lines.indexOf(`END:${type}`) + 1);
}

function rruleOf(observance: string[]): string {
    return observance.find((l) => l.startsWith('RRULE:'))!;
}

function expectedOffsetSec(tzid: string, instant: Date): number {
    const l = utcToLocal(instant, tzid);
    return Math.round((Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - instant.getTime()) / 1000);
}

// ICAL.Timezone.utcOffset expects its Time in the zone's local wall clock, not UTC — converting the UTC
// instant into the zone first yields that frame (a raw UTC Time mis-resolves within ~offset hours of a
// fall-back). This is the ical.js-idiomatic way to ask "what offset does this instant resolve to?".
function icalOffsetSec(icalTz: ICAL.Timezone, instant: Date): number {
    return ICAL.Time.fromJSDate(instant, true).convertToZone(icalTz).utcOffset();
}

// Independent coarse rescan (day steps, refined to the minute) to find transition instants for sampling.
function findTransitions(tzid: string, fromYear: number, toYear: number): Date[] {
    const start = Date.UTC(fromYear, 0, 1);
    const end = Date.UTC(toYear + 1, 0, 1);
    const day = 86_400_000;
    const out: Date[] = [];
    let prev = expectedOffsetSec(tzid, new Date(start));
    for (let t = start + day; t <= end; t += day) {
        const off = expectedOffsetSec(tzid, new Date(t));
        if (off === prev) continue;
        // Refine in whole minutes so the returned instant is minute-aligned (real transitions land on a
        // minute); a sub-minute instant would make Intl's second-truncated offset disagree by ~1s.
        let lo = (t - day) / 60_000;
        let hi = t / 60_000;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (expectedOffsetSec(tzid, new Date(mid * 60_000)) === prev) lo = mid;
            else hi = mid;
        }
        out.push(new Date(hi * 60_000));
        prev = off;
    }
    return out;
}

describe('buildVTimezone', () => {
    test('America/New_York 2025-2027 compresses to one DAYLIGHT + one STANDARD with US DST rules', () => {
        const lines = buildVTimezone('America/New_York', 2025, 2027);
        expect(lines[0]).toBe('BEGIN:VTIMEZONE');
        expect(lines).toContain('TZID:America/New_York');
        expect(count(lines, 'BEGIN:DAYLIGHT')).toBe(1);
        expect(count(lines, 'BEGIN:STANDARD')).toBe(1);

        const daylight = block(lines, 'DAYLIGHT');
        expect(daylight).toContain('TZOFFSETFROM:-0500');
        expect(daylight).toContain('TZOFFSETTO:-0400');
        expect(rruleOf(daylight)).toContain('BYMONTH=3');
        expect(rruleOf(daylight)).toContain('BYDAY=2SU');

        const standard = block(lines, 'STANDARD');
        expect(standard).toContain('TZOFFSETFROM:-0400');
        expect(standard).toContain('TZOFFSETTO:-0500');
        expect(rruleOf(standard)).toContain('BYMONTH=11');
        expect(rruleOf(standard)).toContain('BYDAY=1SU');
    });

    test('Europe/Amsterdam 2025-2027 uses last-Sunday EU DST rules', () => {
        const lines = buildVTimezone('Europe/Amsterdam', 2025, 2027);
        expect(count(lines, 'BEGIN:DAYLIGHT')).toBe(1);
        expect(count(lines, 'BEGIN:STANDARD')).toBe(1);

        const daylight = block(lines, 'DAYLIGHT');
        expect(daylight).toContain('TZOFFSETFROM:+0100');
        expect(daylight).toContain('TZOFFSETTO:+0200');
        expect(rruleOf(daylight)).toContain('BYMONTH=3');
        expect(rruleOf(daylight)).toContain('BYDAY=-1SU');

        const standard = block(lines, 'STANDARD');
        expect(standard).toContain('TZOFFSETFROM:+0200');
        expect(standard).toContain('TZOFFSETTO:+0100');
        expect(rruleOf(standard)).toContain('BYMONTH=10');
        expect(rruleOf(standard)).toContain('BYDAY=-1SU');
    });

    test('Australia/Sydney 2025-2027 uses southern-hemisphere DST rules', () => {
        const lines = buildVTimezone('Australia/Sydney', 2025, 2027);
        expect(count(lines, 'BEGIN:DAYLIGHT')).toBe(1);
        expect(count(lines, 'BEGIN:STANDARD')).toBe(1);

        const daylight = block(lines, 'DAYLIGHT');
        expect(daylight).toContain('TZOFFSETFROM:+1000');
        expect(daylight).toContain('TZOFFSETTO:+1100');
        expect(rruleOf(daylight)).toContain('BYMONTH=10');
        expect(rruleOf(daylight)).toContain('BYDAY=1SU');

        const standard = block(lines, 'STANDARD');
        expect(standard).toContain('TZOFFSETFROM:+1100');
        expect(standard).toContain('TZOFFSETTO:+1000');
        expect(rruleOf(standard)).toContain('BYMONTH=4');
        expect(rruleOf(standard)).toContain('BYDAY=1SU');
    });

    test('fixed-offset zones emit a single STANDARD observance with no RRULE', () => {
        const kolkata = buildVTimezone('Asia/Kolkata', 2025, 2027);
        expect(count(kolkata, 'BEGIN:DAYLIGHT')).toBe(0);
        expect(count(kolkata, 'BEGIN:STANDARD')).toBe(1);
        expect(kolkata).toContain('TZOFFSETFROM:+0530');
        expect(kolkata).toContain('TZOFFSETTO:+0530');
        expect(kolkata.some((l) => l.startsWith('RRULE:'))).toBe(false);

        const utc = buildVTimezone('UTC', 2025, 2027);
        expect(count(utc, 'BEGIN:DAYLIGHT')).toBe(0);
        expect(count(utc, 'BEGIN:STANDARD')).toBe(1);
        expect(utc).toContain('TZOFFSETFROM:+0000');
        expect(utc).toContain('TZOFFSETTO:+0000');
        expect(utc.some((l) => l.startsWith('RRULE:'))).toBe(false);
    });

    // The contract: ical.js must resolve every instant through the generated VTIMEZONE exactly as Intl does.
    for (const tzid of ['America/New_York', 'Europe/Amsterdam', 'Australia/Sydney', 'Asia/Kathmandu']) {
        test(`ical.js resolves ${tzid} identically to Intl across a sample grid`, () => {
            const lines = buildVTimezone(tzid, 2025, 2027);
            const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eigen//test//EN', ...lines, 'END:VCALENDAR'].join(
                '\r\n',
            );
            const vtz = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vtimezone')!;
            const icalTz = new ICAL.Timezone(vtz);

            const samples: Date[] = [];
            for (let y = 2025; y <= 2026; y++) {
                for (let m = 0; m < 12; m++) {
                    samples.push(new Date(Date.UTC(y, m, 1, 12)));
                    samples.push(new Date(Date.UTC(y, m, 15, 12)));
                }
            }
            // Straddle every transition. 90 min, not 60: within the hour immediately before a transition the
            // local wall clock is ambiguous (fall-back) or imaginary (spring-forward), and ical.js's
            // local-time offset lookup cannot pin the UTC side of that seam — the same holds for canonical
            // tzdata VTIMEZONEs. 90 min lands cleanly on each side while still catching any misplaced onset.
            for (const tr of findTransitions(tzid, 2025, 2027)) {
                samples.push(new Date(tr.getTime() - 5_400_000));
                samples.push(new Date(tr.getTime() + 5_400_000));
            }

            const mismatches = samples
                .filter((s) => icalOffsetSec(icalTz, s) !== expectedOffsetSec(tzid, s))
                .map((s) => `${s.toISOString()}: ical=${icalOffsetSec(icalTz, s)} intl=${expectedOffsetSec(tzid, s)}`);
            expect(mismatches).toEqual([]);
        });
    }

    test('results are cached by (tzid, fromYear, toYear)', () => {
        expect(buildVTimezone('America/New_York', 2025, 2027)).toBe(buildVTimezone('America/New_York', 2025, 2027));
    });
});
