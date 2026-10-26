import { describe, expect, test } from 'bun:test';
// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
// @ts-expect-error - No types available for @formulajs/formulajs
import { flatten, flattenShallow } from '@formulajs/formulajs/lib/utils/common.js';

// formulajs 2.9.3's own flattenShallow, which patches/ replaces with a loop.
function originalShallow(array: unknown[]): unknown {
    return array.reduce((a, b) => {
        if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
        if (Array.isArray(a)) {
            a.push(b);
            return a;
        }
        if (Array.isArray(b)) return [a].concat(b);
        return [a, b];
    });
}

function originalFlatten(value: unknown[]): unknown {
    let result: unknown = [...value];
    while (Array.isArray(result) && result.some(Array.isArray)) result = originalShallow(result);
    return result;
}

// A factory each, as the original pushes into its input.
const SHAPES: [string, () => unknown[]][] = [
    [
        'rows of a range',
        () => [
            [1, 2],
            [3, 4],
            [5, 6],
        ],
    ],
    ['one row', () => [[1, 2, 3]]],
    ['one cell', () => [[7]]],
    ['nested deep', () => [[1, [2, [3, [4]]]], 5]],
    ['a scalar first', () => [1, [2, 3], 4]],
    ['an array then a scalar', () => [[1, 2], 3]],
    ['empty arrays', () => [[], [1], [], [[], 2], []]],
    ['only empty arrays', () => [[], [[]]]],
    ['flat', () => [1, 'a', true]],
    ['nothing', () => []],
    ['mixed values', () => [null, [undefined, 'a'], [true, [Number.NaN, formulajs.utils.errors.value]], 0]],
];

describe('formulajs flatten (patches/@formulajs%2Fformulajs@2.9.3.patch)', () => {
    for (const [name, shape] of SHAPES) {
        test(`flattens ${name} as the original did`, () => {
            expect(flatten(shape())).toEqual(originalFlatten(shape()));
        });
    }

    test('one shallow step matches the original, a lone element and no element included', () => {
        for (const [, shape] of SHAPES) {
            const value = shape();
            if (value.length === 0) continue;
            expect(flattenShallow(shape())).toEqual(originalShallow(value));
        }
        expect(flattenShallow([5])).toBe(5);
        expect(() => flattenShallow([])).toThrow(TypeError);
        expect(() => originalShallow([])).toThrow(TypeError);
    });

    test('leaves its input alone', () => {
        const range = [[1, 2], 3];
        flatten(range);
        expect(range).toEqual([[1, 2], 3]);
    });

    // Quadratic, 200,000 rows took minutes; linear, a few milliseconds.
    test('is linear in a range’s rows: 200,000 × 4 in under a second', () => {
        const range = Array.from({ length: 200_000 }, (_, r) => [r, r, r, r]);
        const start = performance.now();
        expect(flatten(range)).toHaveLength(800_000);
        expect(formulajs.COUNT(range)).toBe(800_000);
        expect(performance.now() - start).toBeLessThan(1000);
    });
});
