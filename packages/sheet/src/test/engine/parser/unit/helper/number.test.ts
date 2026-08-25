import { describe, expect, test } from 'bun:test';
import { invertNumber, toNumber } from '../../../../../engine/parser/helper/number';

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
    test('should convert Date to Excel serial (days since 1899-12-30)', () => {
        // 1900-01-01 → serial 2 (Lotus 1900-leap-year bug means day 1 == 1899-12-31).
        expect(toNumber(new Date(Date.UTC(1900, 0, 1)))).toBe(2);
        // 2027-01-01 - 2026-12-31 should be exactly 1 day.
        const a = toNumber(new Date(Date.UTC(2027, 0, 1)))!;
        const b = toNumber(new Date(Date.UTC(2026, 11, 31)))!;
        expect(a - b).toBe(1);
        // 31 days in Jan 2027.
        const jan31 = toNumber(new Date(Date.UTC(2027, 0, 31)))!;
        expect(jan31 - a).toBe(30);
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
