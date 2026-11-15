// The index of rectangles against a model that looks at every rectangle: over random records of one to several
// rectangles of every shape, such as stripes of the sheet's whole height or width, the whole sheet, and small ones
// packed in one band of rows or of columns or lying on the edges of the tiles, a read of a cell and of a rectangle
// lists what the model lists, each rectangle once, through writes, replaces and deletes. And its cost, counted in map
// reads and writes, does not grow with the size of a rectangle or of a read.

import { describe, expect, spyOn, test } from 'bun:test';
import type { Rect } from '@workspace/lib/sheets/ops';
import { RectIndex } from '../../../engine/book/rect-index';
import { LAST_COLUMN, LAST_ROW } from './records-fixtures';

const CASES = 150;
const STEPS = 12;
// The lines where a tile of some size ends, and the grid's last lines.
const ROW_EDGES = [
    0,
    15,
    16,
    31,
    32,
    63,
    64,
    127,
    128,
    4095,
    4096,
    524287,
    524288,
    LAST_ROW - 32,
    LAST_ROW - 31,
    LAST_ROW,
];
const COLUMN_EDGES = [0, 3, 4, 7, 8, 15, 16, 31, 32, 8191, 8192, LAST_COLUMN - 8, LAST_COLUMN - 7, LAST_COLUMN];
const SIZES = [1, 1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 64, 65, 1000, 8192, 8193];

// mulberry32: the same cases on every run.
function randomFrom(seed: number) {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Random = () => number;
type Model = Map<string, Rect[]>;
const below = (random: Random, n: number) => Math.floor(random() * n);
const pick = <T>(random: Random, list: readonly T[]): T => list[below(random, list.length)];
const clamp = (value: number, last: number) => Math.max(0, Math.min(last, value));
const meets = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

const rowOn = (random: Random) => clamp(pick(random, ROW_EDGES) + below(random, 5) - 2, LAST_ROW);
const columnOn = (random: Random) => clamp(pick(random, COLUMN_EDGES) + below(random, 5) - 2, LAST_COLUMN);

function rectOn(random: Random): Rect {
    const roll = random();
    const [top, left] = [rowOn(random), columnOn(random)];
    if (roll < 0.1) return [0, left, LAST_ROW, clamp(left + below(random, 3), LAST_COLUMN)];
    if (roll < 0.2) return [top, 0, clamp(top + below(random, 3), LAST_ROW), LAST_COLUMN];
    if (roll < 0.25) return [0, 0, LAST_ROW, LAST_COLUMN];
    // Small ones packed in one band of rows, then in one band of columns.
    if (roll < 0.4) return [32 + below(random, 16), below(random, 40), 48 + below(random, 16), below(random, 40) + 40];
    if (roll < 0.55) return [below(random, 80), 8 + below(random, 4), below(random, 80) + 80, 12 + below(random, 4)];
    return [
        top,
        left,
        clamp(top + pick(random, SIZES) - 1, LAST_ROW),
        clamp(left + pick(random, SIZES) - 1, LAST_COLUMN),
    ];
}

const listed = (pairs: readonly (readonly [string, Rect])[]) =>
    pairs.map(([id, rect]) => `${id}:${rect.join(',')}`).sort();

function expectReads(index: RectIndex, model: Model, random: Random): void {
    const all = [...model].flatMap(([id, rects]) => rects.map((rect): [string, Rect] => [id, rect]));
    const queries: Rect[] = [[0, 0, LAST_ROW, LAST_COLUMN]];
    for (const [, [top, left, bottom, right]] of all.slice(0, 8)) {
        for (const row of [top - 1, top, bottom, bottom + 1]) {
            for (const column of [left - 1, left, right, right + 1]) {
                const [r, c] = [clamp(row, LAST_ROW), clamp(column, LAST_COLUMN)];
                queries.push([r, c, r, c]);
            }
        }
        queries.push([top, left, bottom, right], [clamp(top - 40, LAST_ROW), clamp(left - 10, LAST_COLUMN), top, left]);
    }
    // Every cell of a region over the packed bands, and of one at a random place.
    for (const [row, column] of [
        [28 + below(random, 8), 4 + below(random, 8)],
        [rowOn(random), columnOn(random)],
    ]) {
        for (let r = row; r < row + 9 && r <= LAST_ROW; r += 1) {
            for (let c = column; c < column + 9 && c <= LAST_COLUMN; c += 1) queries.push([r, c, r, c]);
        }
    }
    for (let i = 0; i < 8; i += 1) {
        const [top, left] = [rowOn(random), columnOn(random)];
        queries.push([
            top,
            left,
            clamp(top + pick(random, SIZES) * (1 + below(random, 3)), LAST_ROW),
            clamp(left + pick(random, SIZES), LAST_COLUMN),
        ]);
    }
    const column = columnOn(random);
    const row = rowOn(random);
    queries.push([0, column, LAST_ROW, column], [row, 0, row, LAST_COLUMN], [0, 0, 60, 30]);
    for (const query of queries) {
        const expected = all.filter(([, rect]) => meets(rect, query));
        expect({ query, found: listed(index.meeting(query)) }).toEqual({ query, found: listed(expected) });
    }
}

test('a read lists the rectangles the model lists, each once, through writes, replaces and deletes', () => {
    const random = randomFrom(41);
    const seen = { tall: 0, wide: 0, whole: 0, several: 0, deleted: 0 };
    for (let i = 0; i < CASES; i += 1) {
        const index = new RectIndex();
        const model: Model = new Map();
        for (let step = 0; step < STEPS; step += 1) {
            const ids = [...model.keys()];
            const roll = random();
            const id = roll < 0.55 || ids.length === 0 ? `r${step}` : pick(random, ids);
            const first = rectOn(random);
            // One rectangle, several, or one listed twice, as a rule's ranges may be.
            const more = random() < 0.4 ? Array.from({ length: below(random, 5) }, () => rectOn(random)) : [];
            const next = roll > 0.85 ? undefined : random() < 0.1 ? [first, first, ...more] : [first, ...more];
            index.set(id, model.get(id), next);
            if (next) model.set(id, next);
            else model.delete(id);
            for (const [top, left, bottom, right] of next ?? []) {
                if (top === 0 && bottom === LAST_ROW && right < LAST_COLUMN) seen.tall += 1;
                if (left === 0 && right === LAST_COLUMN && bottom < LAST_ROW) seen.wide += 1;
                if (top === 0 && bottom === LAST_ROW && left === 0 && right === LAST_COLUMN) seen.whole += 1;
            }
            if (next && next.length > 1) seen.several += 1;
            if (!next && ids.includes(id)) seen.deleted += 1;
            expectReads(index, model, random);
        }
    }
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(CASES / 3);
});

describe('the edges of a tile', () => {
    const one = (rect: Rect) => {
        const index = new RectIndex();
        index.set('a', undefined, [rect]);
        return index;
    };
    const ids = (index: RectIndex, query: Rect) => index.meeting(query).map(([id]) => id);

    test('a rectangle on the first and the last line of a tile is found there and not a line past it', () => {
        const index = one([32, 8, 63, 15]);
        for (const [row, column] of [
            [32, 8],
            [63, 15],
            [32, 15],
            [63, 8],
        ]) {
            expect(ids(index, [row, column, row, column])).toEqual(['a']);
        }
        for (const [row, column] of [
            [31, 8],
            [64, 15],
            [32, 7],
            [63, 16],
        ]) {
            expect(ids(index, [row, column, row, column])).toEqual([]);
        }
    });

    test('a rectangle across four tiles is listed once by a read of any of them or of all', () => {
        const index = one([31, 7, 32, 8]);
        for (const query of [
            [31, 7, 31, 7],
            [31, 8, 31, 8],
            [32, 7, 32, 7],
            [32, 8, 32, 8],
            [0, 0, 100, 100],
            [32, 0, 100, 100],
            [0, 8, 100, 100],
            [0, 0, LAST_ROW, LAST_COLUMN],
        ] satisfies Rect[]) {
            expect({ query, found: ids(index, query) }).toEqual({ query, found: ['a'] });
        }
        expect(ids(index, [33, 7, 33, 8])).toEqual([]);
        expect(ids(index, [31, 9, 32, 9])).toEqual([]);
    });

    test('a rectangle of a size past a power of two lies in the larger tiles', () => {
        // 33 rows from row 31 reach into a third tile of 32 rows, and 9 columns from column 7 into a third of 8.
        for (const rect of [
            [31, 0, 63, 0],
            [31, 0, 64, 0],
            [0, 7, 0, 15],
            [0, 7, 0, 16],
            [1023, 0, 2047, 0],
            [1023, 0, 2048, 0],
        ] satisfies Rect[]) {
            const index = one(rect);
            const [top, left, bottom, right] = rect;
            const [row, column] = [(top + bottom) >> 1, (left + right) >> 1];
            expect({ rect, found: ids(index, [row, column, row, column]) }).toEqual({ rect, found: ['a'] });
            expect({ rect, found: ids(index, [bottom, right, bottom, right]) }).toEqual({ rect, found: ['a'] });
            expect({ rect, found: ids(index, [top, left, bottom, right]) }).toEqual({ rect, found: ['a'] });
        }
    });

    test('a rectangle to the last row and the last column is found on them', () => {
        const index = one([LAST_ROW - 1, LAST_COLUMN - 1, LAST_ROW, LAST_COLUMN]);
        index.set('open', undefined, [[5, 3, LAST_ROW, 3]]);
        index.set('wide', undefined, [[7, 2, 7, LAST_COLUMN]]);
        expect(ids(index, [LAST_ROW, LAST_COLUMN, LAST_ROW, LAST_COLUMN])).toEqual(['a']);
        expect(ids(index, [LAST_ROW, 3, LAST_ROW, 3])).toEqual(['open']);
        expect(ids(index, [7, LAST_COLUMN, 7, LAST_COLUMN])).toEqual(['wide']);
        expect(ids(index, [LAST_ROW, 0, LAST_ROW, LAST_COLUMN]).sort()).toEqual(['a', 'open']);
        expect(ids(index, [4, 3, 4, 3])).toEqual([]);
    });

    test('a replace and a delete take every old rectangle out, two in one tile included', () => {
        const index = new RectIndex();
        const old: Rect[] = [
            [0, 0, 0, 0],
            [1, 1, 1, 1],
            [100, 100, LAST_ROW, 100],
        ];
        index.set('a', undefined, old);
        index.set('b', undefined, [[0, 0, 0, 0]]);
        const next: Rect[] = [[2, 2, 2, 2]];
        index.set('a', old, next);
        expect(listed(index.meeting([0, 0, LAST_ROW, LAST_COLUMN]))).toEqual(['a:2,2,2,2', 'b:0,0,0,0']);
        index.set('a', next, undefined);
        expect(listed(index.meeting([0, 0, LAST_ROW, LAST_COLUMN]))).toEqual(['b:0,0,0,0']);
    });
});

describe('what the index costs', () => {
    const COUNT = 1000;
    const built = (rectOf: (i: number) => Rect) => {
        const sets = spyOn(Map.prototype, 'set');
        const index = new RectIndex();
        for (let i = 0; i < COUNT; i += 1) index.set(`r${i}`, undefined, [rectOf(i)]);
        const writes = sets.mock.calls.length;
        sets.mockRestore();
        return { index, writes };
    };
    const reads = (index: RectIndex, query: Rect) => {
        const gets = spyOn(Map.prototype, 'get');
        const found = index.meeting(query).length;
        const count = gets.mock.calls.length;
        gets.mockRestore();
        return { found, count };
    };

    test('a rectangle costs the same to list whatever its height, its width or its area', () => {
        const small = built((i) => [0, i, 1, i]).writes;
        expect(small).toBeLessThan(4 * COUNT);
        expect(built((i) => [0, i, LAST_ROW, i]).writes).toBeLessThanOrEqual(small);
        expect(built((i) => [i * 2, 0, i * 2, LAST_COLUMN]).writes).toBeLessThanOrEqual(small);
        expect(built(() => [0, 0, LAST_ROW, LAST_COLUMN]).writes).toBeLessThanOrEqual(small);
        expect(built((i) => [31, i * 8 + 7, 32, i * 8 + 8]).writes).toBeLessThanOrEqual(4 * small);
    });

    test('a read of a cell looks at one tile of each size in use, however many rectangles lie elsewhere', () => {
        const stripes = built((i) => [0, i, LAST_ROW, i]).index;
        expect(reads(stripes, [500, 500, 500, 500])).toEqual({ found: 1, count: 1 });
        const band = built((i) => [i % 64, 2 * (i >> 6), i % 64, 2 * (i >> 6) + 1]).index;
        expect(reads(band, [40, 3, 40, 3])).toEqual({ found: 1, count: 1 });
    });

    test('a read of a large rectangle looks at the tiles in use, not at every tile it covers', () => {
        const small = built((i) => [i * 40, (i * 10) % 4000, i * 40, (i * 10) % 4000]).index;
        const whole = reads(small, [0, 0, LAST_ROW, LAST_COLUMN]);
        expect(whole.found).toBe(COUNT);
        expect(whole.count).toBeLessThanOrEqual(COUNT);
        const part = reads(small, [0, 0, 100, 30]);
        expect(part.found).toBe(3);
        expect(part.count).toBeLessThan(100);
    });
});
