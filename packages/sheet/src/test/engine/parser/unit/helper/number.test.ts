import { describe, expect, test } from 'bun:test';
import { dateToSerial, invertNumber, toNumber } from '../../../../../engine/parser/helper/number';

describe('.toNumber()', () => {
    test('should correctly convert passed value into number', () => {
        expect(toNumber(-100)).toBe(-100);
        expect(toNumber(-1)).toBe(-1);
        expect(toNumber(19)).toBe(19);
        expect(toNumber(19.9)).toBe(19.9);
        expect(toNumber(0.9)).toBe(0.9);
        expect(toNumber('0.9')).toBe(0.9);
        expect(toNumber('0')).toBe(0);
        expect(toNumber('-10')).toBe(-10);
        expect(toNumber('1e3')).toBe(1000);
        expect(toNumber(' -10 ')).toBe(-10);
        const result1 = toNumber('foo');
        expect(result1 === undefined || Number.isNaN(result1)).toBe(true);
    });

    // Date inputs come from formulajs date functions (DATEVALUE, EOMONTH, etc.)
    // — those return JS Dates, but Excel returns serials. Coercing here is what
    // makes `EOMONTH(d,0) - EOMONTH(d,-1)` produce a day count instead of either
    // milliseconds (via .valueOf()) or NaN.
    test('should convert Date to Excel serial', () => {
        // Excel's serial 1 is 1900-01-01; the Lotus leap-year bug puts 1900-03-01 at 61.
        expect(toNumber(new Date(1900, 0, 1))).toBe(1);
        expect(toNumber(new Date(1900, 1, 28))).toBe(59);
        expect(toNumber(new Date(1900, 2, 1))).toBe(61);
        expect(toNumber(new Date(2026, 0, 5))).toBe(46027);
        // 2027-01-01 - 2026-12-31 should be exactly 1 day.
        const a = toNumber(new Date(2027, 0, 1))!;
        const b = toNumber(new Date(2026, 11, 31))!;
        expect(a - b).toBe(1);
        // 31 days in Jan 2027.
        const jan31 = toNumber(new Date(2027, 0, 31))!;
        expect(jan31 - a).toBe(30);
    });

    test('a local-midnight Date keeps its calendar day in every timezone', () => {
        // formulajs builds DATE(2026,1,5) as local midnight; west of Greenwich that instant
        // is still 4 January in UTC, and the serial must not follow it there.
        const tz = process.env.TZ;
        try {
            for (const zone of ['Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland']) {
                process.env.TZ = zone;
                expect(dateToSerial(new Date(2026, 0, 5))).toBe(46027);
                expect(dateToSerial(new Date(2026, 0, 5, 12))).toBe(46027.5);
            }
        } finally {
            process.env.TZ = tz;
        }
    });
});

describe('.invertNumber()', () => {
    test('should correctly invert number', () => {
        expect(invertNumber(-100)).toBe(100);
        expect(invertNumber(-1)).toBe(1);
        expect(invertNumber(19)).toBe(-19);
        expect(invertNumber(19.9)).toBe(-19.9);
        expect(invertNumber(0.9)).toBe(-0.9);
        expect(invertNumber('0.9')).toBe(-0.9);
        expect(invertNumber('0')).toBe(-0);
        expect(invertNumber('-10')).toBe(10);
        expect(invertNumber(' -10 ')).toBe(10);
        const result2 = invertNumber('foo');
        expect(result2 === undefined || Number.isNaN(result2)).toBe(true);
    });
});
