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
    });

    test("Google's answers from before 1900", () => {
        expect(all(-141500, 45000)).toEqual([510, 6127, 186500, 14, 7, 226]);
        expect(all(-141500, -141000)).toEqual([1, 16, 500, 13, 4, 135]);
        expect(dateDif(-10, 10, 'M')).toBe(0);
        expect(dateDif(-141639, 1, 'Y')).toBe(387);
        expect(dateDif(10, -10, 'D')).toBe(NUM);
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
        expect(days360(0, 10, false)).toBe(9);
        expect(days360(1, 10, false)).toBe(9);
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
        near(yearFraction(60, 61, 0), 1 / 360);
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

// The calendar repeats every 400 years, 146,097 days and a whole number of weeks. So what a span measures by its
// days, months and years is the same 400 years earlier: the spans Excel recorded hold for every century.
describe('the whole range', () => {
    const CYCLE = 146097;
    const UNITS = ['Y', 'M', 'D', 'MD', 'YM', 'YD'];

    test('a span measures the same in every 400 years down to the year 1 and up to 9999', () => {
        let wrong = 0;
        let spans = 0;
        // Starts on every day of four years with a leap day, 2023 to 2026, each with a few lengths.
        for (let start = 44927; start < 44927 + 1461; start += 1) {
            for (const length of [0, 1, 28, 31, 59, 365, 366, 400, 731, 1461, 3000]) {
                const end = start + length;
                spans += 1;
                for (let cycles = -5; cycles <= 19; cycles += 1) {
                    const a = start + cycles * CYCLE;
                    const b = end + cycles * CYCLE;
                    if (cycles === 0 || a < -693593 || b > 2958465) continue;
                    for (const unit of UNITS) if (dateDif(a, b, unit) !== dateDif(start, end, unit)) wrong += 1;
                    if (days360(a, b, false) !== days360(start, end, false)) wrong += 1;
                    if (days360(b, a, true) !== days360(end, start, true)) wrong += 1;
                    for (let basis = 0; basis < 5; basis += 1) {
                        const here = yearFraction(start, end, basis);
                        const there = yearFraction(b, a, basis);
                        if (here !== there) wrong += 1;
                    }
                }
            }
        }
        expect(spans).toBe(1461 * 11);
        expect(wrong).toBe(0);
    });

    test('whole days are counted one by one across serial 0 and at both ends', () => {
        for (const [start, end] of [
            [-400, 400],
            [-693593, -693000],
            [2958000, 2958465],
            [-693593, 2958465],
        ]) {
            expect(dateDif(start, end, 'D')).toBe(end - start);
            expect(yearFraction(start, end, 3)).toBe((end - start) / 365);
        }
        expect(dateDif(-693593, 2958465, 'Y')).toBe(9998);
        expect(dateDif(-693593, 2958465, 'M')).toBe(9999 * 12 - 1);
        expect(days360(-693593, 2958465, false)).toBe(9999 * 360);
        expect(yearFraction(-693593, 2958465, 0)).toBe(9999);
    });
});
