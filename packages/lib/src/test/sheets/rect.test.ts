import { describe, expect, test } from 'bun:test';
import type { Rect } from '../../sheets/ops';
import { covers, disjoint, meets, sameRect, within } from '../../sheets/rect';

describe('meets', () => {
    test('two rectangles that share a cell meet, either way round', () => {
        expect(meets([0, 0, 2, 2], [2, 2, 4, 4])).toBe(true);
        expect(meets([2, 2, 4, 4], [0, 0, 2, 2])).toBe(true);
    });

    test('rectangles side by side or one above the other do not', () => {
        expect(meets([0, 0, 2, 2], [0, 3, 2, 4])).toBe(false);
        expect(meets([0, 0, 2, 2], [3, 0, 4, 2])).toBe(false);
    });
});

describe('within', () => {
    test('a rectangle is within itself and within a larger one', () => {
        expect(within([1, 1, 2, 2], [1, 1, 2, 2])).toBe(true);
        expect(within([1, 1, 2, 2], [0, 0, 3, 3])).toBe(true);
    });

    test('a rectangle that crosses an edge is not', () => {
        expect(within([1, 1, 4, 2], [0, 0, 3, 3])).toBe(false);
        expect(within([0, 0, 3, 3], [1, 1, 2, 2])).toBe(false);
    });
});

describe('covers', () => {
    test('a range covers the cells on its edges and inside', () => {
        const range = { row: [1, 3], column: [2, 4] };
        expect(covers(range, 1, 2)).toBe(true);
        expect(covers(range, 3, 4)).toBe(true);
        expect(covers(range, 0, 2)).toBe(false);
        expect(covers(range, 1, 5)).toBe(false);
    });
});

describe('sameRect', () => {
    test('compares every corner', () => {
        expect(sameRect([0, 1, 2, 3], [0, 1, 2, 3])).toBe(true);
        for (const other of [
            [9, 1, 2, 3],
            [0, 9, 2, 3],
            [0, 1, 9, 3],
            [0, 1, 2, 9],
        ] satisfies Rect[])
            expect(sameRect([0, 1, 2, 3], other)).toBe(false);
    });
});

describe('disjoint', () => {
    test('no rectangle, one, or rectangles that share no cell are disjoint', () => {
        expect(disjoint([])).toBe(true);
        expect(disjoint([[0, 0, 5, 5]])).toBe(true);
        expect(
            disjoint([
                [0, 0, 1, 1],
                [0, 2, 1, 3],
                [2, 0, 3, 3],
            ]),
        ).toBe(true);
    });

    test('two that share one corner cell are not', () => {
        expect(
            disjoint([
                [0, 0, 2, 2],
                [5, 5, 6, 6],
                [2, 2, 3, 3],
            ]),
        ).toBe(false);
    });

    test('agrees with meets on every pair of random rectangles', () => {
        let state = 7;
        const next = () => {
            state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
            return state % 12;
        };
        for (let round = 0; round < 500; round += 1) {
            const rects: Rect[] = Array.from({ length: 4 }, () => {
                const [top, left] = [next(), next()];
                return [top, left, top + (next() % 4), left + (next() % 4)];
            });
            const anyMeet = rects.some((a, i) => rects.some((b, j) => i < j && meets(a, b)));
            expect(disjoint(rects)).toBe(!anyMeet);
        }
    });
});
