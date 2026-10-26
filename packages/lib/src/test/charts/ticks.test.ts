import { describe, expect, test } from 'bun:test';
import { formatTickValue, nice, tickStep, ticks } from '../../charts/ticks';

// The cases d3-array's README and test suite document for ticks, tickStep and nice.
describe('ticks', () => {
    test("d3's documented examples", () => {
        expect(ticks(1, 9, 5)).toEqual([2, 4, 6, 8]);
        expect(ticks(1, 9, 20)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9]);
        expect(ticks(0, 1, 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
        expect(ticks(-10, 10, 5)).toEqual([-10, -5, 0, 5, 10]);
        expect(ticks(0, 100, 4)).toEqual([0, 20, 40, 60, 80, 100]);
        expect(ticks(1, 1, 5)).toEqual([1]);
        expect(ticks(0, 1, 0)).toEqual([]);
    });

    test('tickStep is the step itself', () => {
        expect(tickStep(1, 9, 5)).toBe(2);
        expect(tickStep(1, 9, 20)).toBe(0.5);
        expect(tickStep(0, 1, 10)).toBe(0.1);
    });

    test('nice extends the domain to whole steps', () => {
        expect(nice(1, 9, 5)).toEqual([0, 10]);
        expect(nice(0.5, 9.5, 10)).toEqual([0, 10]);
        expect(nice(0.132, 0.876, 1000)).toEqual([0.132, 0.876]);
        expect(nice(0.132, 0.876, 100)).toEqual([0.13, 0.88]);
        expect(nice(0.132, 0.876, 30)).toEqual([0.12, 0.88]);
        expect(nice(0.132, 0.876, 10)).toEqual([0.1, 0.9]);
        expect(nice(0.132, 0.876, 5)).toEqual([0, 1]);
        expect(nice(132, 876, 100)).toEqual([130, 880]);
        expect(nice(132, 876, 5)).toEqual([0, 1000]);
        expect(nice(0, 80, 4)).toEqual([0, 80]);
        expect(nice(0, 81, 4)).toEqual([0, 100]);
        const [lo, hi] = nice(-1, 2, 1);
        expect(Number.isFinite(lo) && Number.isFinite(hi) && lo <= -1 && hi >= 2).toBe(true);
    });
});

describe('formatTickValue', () => {
    test('precision follows the step', () => {
        expect(formatTickValue(0.3, 0.1)).toBe('0.3');
        expect(formatTickValue(1, 0.1)).toBe('1.0');
        expect(formatTickValue(0.05, 0.05)).toBe('0.05');
        expect(formatTickValue(20, 20)).toBe('20');
    });

    test('thousands separators in the en locale', () => {
        expect(formatTickValue(1000, 1000)).toBe('1,000');
        expect(formatTickValue(-2500000, 500000)).toBe('-2,500,000');
    });

    test('never -0', () => {
        expect(formatTickValue(-0, 1)).toBe('0');
        expect(formatTickValue(-0.00001, 0.1)).toBe('0.0');
        expect(formatTickValue(-1e-17, 0.1)).toBe('0.0');
    });

    test('scientific past six decimals or a step of 1e15, each label distinct', () => {
        expect([0, 5e-21, 1e-20, 1.5e-20].map((value) => formatTickValue(value, 5e-21))).toEqual([
            '0',
            '5E-21',
            '1.0E-20',
            '1.5E-20',
        ]);
        expect(formatTickValue(-0, 1e-9)).toBe('0');
        expect(formatTickValue(-2e-9, 1e-9)).toBe('-2E-9');
        expect(formatTickValue(0.000005, 0.000001)).toBe('0.000005');
        expect(formatTickValue(2e99, 1e99)).toBe('2E99');
        expect(formatTickValue(1e100, 1e99)).toBe('1.0E100');
        expect(formatTickValue(1e14, 1e14)).toBe('100,000,000,000,000');
        expect(formatTickValue(2.5e15, 5e14)).toBe('2,500,000,000,000,000');
        expect(formatTickValue(2.5e16, 5e15)).toBe('2.5E16');
    });
});
