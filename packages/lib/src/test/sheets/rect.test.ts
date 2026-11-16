import { describe, expect, test } from 'bun:test';
import type { Rect } from '../../sheets/ops';
import { apart, covers, disjoint, intersect, meets, outsideOf, sameRect, within } from '../../sheets/rect';

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
    test('a rectangle covers the cells on its edges and inside', () => {
        const range: Rect = [1, 2, 3, 4];
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

describe('apart', () => {
    test('an empty side is apart from anything, and rectangles of one side may share cells', () => {
        expect(apart([], [[0, 0, 5, 5]])).toBe(true);
        expect(apart([[0, 0, 5, 5]], [])).toBe(true);
        const side: Rect[] = [
            [0, 0, 5, 5],
            [2, 2, 3, 3],
        ];
        expect(apart(side, [[6, 0, 6, 5]])).toBe(true);
        expect(apart(side, [[5, 5, 9, 9]])).toBe(false);
    });

    test('agrees with meets on every pair across two random sides', () => {
        let state = 11;
        const next = () => {
            state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
            return state % 12;
        };
        const seen = { apart: 0, meet: 0 };
        for (let round = 0; round < 2000; round += 1) {
            const [a, b] = [1 + (next() % 4), 1 + (next() % 4)].map((count) =>
                Array.from({ length: count }, (): Rect => {
                    const [top, left] = [next(), next()];
                    return [top, left, top + (next() % 4), left + (next() % 4)];
                }),
            );
            const anyMeet = a.some((x) => b.some((y) => meets(x, y)));
            expect(apart(a, b)).toBe(!anyMeet);
            seen[anyMeet ? 'meet' : 'apart'] += 1;
        }
        expect(Math.min(seen.apart, seen.meet)).toBeGreaterThan(200);
    });

    test('agrees with meets on long sides, which it sweeps', () => {
        let state = 13;
        const next = (most: number) => {
            state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
            return state % most;
        };
        const seen = { apart: 0, meet: 0 };
        for (let round = 0; round < 300; round += 1) {
            const [a, b] = [40 + next(30), 40 + next(30)].map((count) =>
                Array.from({ length: count }, (): Rect => {
                    const [top, left] = [next(600), next(600)];
                    return [top, left, top + next(3), left + next(3)];
                }),
            );
            const anyMeet = a.some((x) => b.some((y) => meets(x, y)));
            expect(apart(a, b)).toBe(!anyMeet);
            seen[anyMeet ? 'meet' : 'apart'] += 1;
        }
        expect(Math.min(seen.apart, seen.meet)).toBeGreaterThan(50);
    });
});

describe('intersect and outsideOf', () => {
    test('the cells two rectangles share, or none', () => {
        expect(intersect([0, 0, 5, 5], [3, 4, 9, 9])).toEqual([3, 4, 5, 5]);
        expect(intersect([0, 0, 5, 5], [5, 5, 5, 5])).toEqual([5, 5, 5, 5]);
        expect(intersect([0, 0, 5, 5], [6, 0, 9, 5])).toBeNull();
    });

    test('the cells of a rectangle a block does not hold, in at most four rectangles', () => {
        expect(outsideOf([0, 0, 9, 9], [3, 3, 5, 5])).toEqual([
            [0, 0, 2, 9],
            [6, 0, 9, 9],
            [3, 0, 5, 2],
            [3, 6, 5, 9],
        ]);
        expect(outsideOf([0, 0, 2, 2], [5, 5, 6, 6])).toEqual([[0, 0, 2, 2]]);
        expect(outsideOf([3, 3, 5, 5], [0, 0, 9, 9])).toEqual([]);
    });
});
