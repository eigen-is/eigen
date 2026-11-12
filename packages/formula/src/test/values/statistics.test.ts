import { describe, expect, test } from 'bun:test';
import { coDeviations, interpolated, mean, rankAmong, squaredDeviations } from '../../values/statistics';

const DATA = Float64Array.of(3, 1, 4, 1, 5, 9, 2, 6);
const SORTED = Float64Array.of(1, 1, 2, 3, 4, 5, 6, 9);

describe('mean, squaredDeviations and coDeviations', () => {
    test('the mean of the numbers, and no number of none', () => {
        expect(mean(DATA)).toBe(3.875);
        expect(mean(new Float64Array(0))).toBeNaN();
    });

    test('the squares of the distances to the mean, added', () => {
        expect(squaredDeviations(DATA)).toBe(52.875);
        expect(squaredDeviations(Float64Array.of(5))).toBe(0);
        expect(squaredDeviations(new Float64Array(0))).toBe(0);
    });

    test('equal numbers too large to square lie at no distance from their mean', () => {
        expect(squaredDeviations(Float64Array.of(1e200, 1e200))).toBe(0);
        expect(squaredDeviations(Float64Array.of(1.5, -2.5, 0, 10, 1e300))).toBe(Number.POSITIVE_INFINITY);
    });

    test('the distances of two lists to their means, multiplied place by place and added', () => {
        expect(coDeviations(DATA, Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toBe(22.5);
        expect(coDeviations(DATA, DATA)).toBe(squaredDeviations(DATA));
        expect(coDeviations(Float64Array.of(1, 2), Float64Array.of(5, 3))).toBe(-1);
        expect(coDeviations(new Float64Array(0), new Float64Array(0))).toBe(0);
    });
});

describe('interpolated', () => {
    test.each([
        [0, 1],
        [7, 9],
        [3.5, 3.5],
        [1.75, 1.75],
        [6.3, 6.9],
        [6.125, 6.375],
    ])('position %p of the sorted list is %p', (position, expected) => {
        expect(interpolated(SORTED, position)).toBeCloseTo(expected, 12);
    });

    test('a whole position reads no neighbour, so the last one is the last number', () => {
        expect(interpolated(Float64Array.of(1, Number.MAX_VALUE), 1)).toBe(Number.MAX_VALUE);
    });
});

describe('rankAmong', () => {
    test.each([
        [5, false, false, 3],
        [5, true, false, 6],
        [1, false, false, 7],
        [1, true, false, 1],
        [9, false, false, 1],
        [1, false, true, 7.5],
        [1, true, true, 1.5],
        [5, false, true, 3],
    ])('%p, ascending %p, shared %p is %p', (value, ascending, shared, expected) => {
        expect(rankAmong(DATA, value, ascending, shared)).toBe(expected);
    });

    test('a number the list does not hold has no rank', () => {
        expect(rankAmong(DATA, 7, false, false)).toBe(0);
        expect(rankAmong(DATA, 1.5, true, true)).toBe(0);
        expect(rankAmong(new Float64Array(0), 1, false, false)).toBe(0);
    });
});
