import { describe, expect, test } from 'bun:test';
import { dateDif, days360, yearFraction } from '../../values/date-spans';
import { NUM } from '../../values/errors';

// 45351 is 29 February 2024, 45716 28 February 2025, 44985 28 February 2023, 45016 31 March 2023.
describe('dateDif', () => {
    const all = (start: number, end: number) =>
        ['Y', 'M', 'D', 'MD', 'YM', 'YD'].map((unit) => dateDif(start, end, unit));

    test("Excel's answers, unit by unit", () => {
        expect(all(45000, 45400)).toEqual([1, 13, 400, 3, 1, 34]);
        expect(all(45351, 45716)).toEqual([0, 11, 365, 30, 11, 365]);
        expect(all(45351, 45717)).toEqual([1, 12, 366, 0, 0, 0]);
        expect(all(45351, 46081)).toEqual([1, 23, 730, 30, 11, 365]);
        expect(all(45351, 46082)).toEqual([2, 24, 731, 0, 0, 0]);
        expect(all(45351, 45383)).toEqual([0, 1, 32, 3, 1, 32]);
        expect(all(43891, 45351)).toEqual([3, 47, 1460, 28, 11, 365]);
        expect(all(0, 366)).toEqual([0, 11, 366, 31, 11, 366]);
    });

    test('a unit in lower case counts, any other text and a start after the end are #NUM!', () => {
        expect(dateDif(45000, 45400, 'yd')).toBe(34);
        expect(dateDif(45000, 45400, 'YMD')).toBe(NUM);
        expect(dateDif(45000, 45400, '')).toBe(NUM);
        expect(dateDif(45400, 45000, 'D')).toBe(NUM);
    });
});

describe('days360', () => {
    test('the American method', () => {
        expect(days360(45000, 45400, false)).toBe(393);
        expect(days360(45351, 45382, false)).toBe(30);
        expect(days360(45351, 45351, false)).toBe(-1);
        expect(days360(44957, 44986, false)).toBe(31);
        expect(days360(45716, 45351, false)).toBe(-361);
        expect(days360(60, 61, false)).toBe(1);
        expect(days360(59, 61, false)).toBe(3);
    });

    test('the European method', () => {
        expect(days360(45351, 45382, true)).toBe(31);
        expect(days360(44985, 45016, true)).toBe(32);
        expect(days360(45504, 45565, true)).toBe(60);
    });
});

describe('yearFraction', () => {
    const near = (value: unknown, expected: number) => expect(value).toBeCloseTo(expected, 13);

    test('each basis, in either order', () => {
        near(yearFraction(45000, 45400, 0), 393 / 360);
        near(yearFraction(45400, 45000, 1), 400 / 365.5);
        near(yearFraction(45000, 45400, 2), 400 / 360);
        near(yearFraction(45000, 45400, 3), 400 / 365);
        near(yearFraction(45351, 45716, 4), 359 / 360);
        expect(yearFraction(45000, 45400, 5)).toBe(NUM);
        expect(yearFraction(45000, 45400, -1)).toBe(NUM);
    });

    test('basis 0 is not DAYS360 around the end of February', () => {
        expect(yearFraction(45351, 45716, 0)).toBe(1);
        near(yearFraction(44985, 45016, 0), 31 / 360);
        near(yearFraction(60, 61, 0), 2 / 360);
    });

    test('basis 1 divides by the year the span is in, or the mean of the years it touches', () => {
        near(yearFraction(45351, 45716, 1), 365 / 366);
        expect(yearFraction(43891, 44256, 1)).toBe(1);
        near(yearFraction(45473, 45504, 1), 31 / 366);
        near(yearFraction(45290, 45321, 1), 31 / 365);
        near(yearFraction(45000, 45730, 1), 730 / (1096 / 3));
        expect(yearFraction(45000, 45000, 1)).toBe(0);
    });
});
