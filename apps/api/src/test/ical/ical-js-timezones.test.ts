import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { parseIcs } from '../../lib/ical';
import { cpuClock } from '../cpu-time';
import { vcal } from '../ics-test-helpers';

const vtimezone = (tzid: string, offset: string) => [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    'END:STANDARD',
    'END:VTIMEZONE',
];

const vevent = (uid: string, tzid: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=${tzid}:20260601T120000`,
    'END:VEVENT',
];

const parsed = (...blocks: string[][]) => new ICAL.Component(ICAL.parse(vcal(...blocks)));

describe('ical.js time zone lookup', () => {
    test('a zone the file defines is found, whatever stands around it', () => {
        const root = parsed(vevent('a', 'Own'), vtimezone('Other', '+0300'), vtimezone('Own', '+0500'));

        expect(root.getTimeZoneByID('Own')?.tzid).toBe('Own');
        expect(root.getTimeZoneByID('Other')?.tzid).toBe('Other');
        expect(root.getTimeZoneByID('Missing')).toBeNull();
    });

    test('of two zones with one TZID the first is the one', () => {
        const { events } = parseIcs(vcal(vtimezone('Own', '+0500'), vtimezone('Own', '+0300'), vevent('a', 'Own')));

        expect(events[0].startTime.toISOString()).toBe('2026-06-01T07:00:00.000Z');
    });

    test('a zone added after a miss is found', () => {
        const root = parsed(vevent('a', 'Own'));
        expect(root.getTimeZoneByID('Own')).toBeNull();

        root.addSubcomponent(parsed(vtimezone('Own', '+0500')).getAllSubcomponents('vtimezone')[0]);

        expect(root.getTimeZoneByID('Own')?.tzid).toBe('Own');
    });

    test('a zone with no TZID hides no other zone and no event', () => {
        const { events, skipped } = parseIcs(
            vcal(
                ['BEGIN:VTIMEZONE', 'END:VTIMEZONE'],
                vtimezone('Own', '+0500'),
                vevent('a', 'Own'),
                vevent('b', 'Own'),
            ),
        );

        expect(skipped).toBe(0);
        expect(events.map((event) => event.startTime.toISOString())).toEqual([
            '2026-06-01T07:00:00.000Z',
            '2026-06-01T07:00:00.000Z',
        ]);
    });

    test.each([
        ['one zone', () => 'Nowhere'],
        ['a zone each', (i: number) => `Nowhere${i}`],
    ])('events naming an undefined zone, %s, cost one lookup each', (_name, zone) => {
        const events = Array.from({ length: 20_000 }, (_, i) => vevent('a', zone(i))).flat();
        const body = vcal(events);

        const cpuMs = cpuClock();
        const { events: rows } = parseIcs(body);

        expect(cpuMs()).toBeLessThan(1500);
        expect(rows).toHaveLength(20_000);
    });
});
