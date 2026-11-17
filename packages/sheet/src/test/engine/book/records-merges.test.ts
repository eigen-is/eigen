// The merge index against a model that looks at every merge record: over random sets of merges that share no cell,
// tall, wide, touching and a cell apart, the merge of a cell and the merges of a rectangle read the same as the model,
// before and after record writes, line edits and moves. And the cost of the index, counted in map writes, does not
// grow with the size of a merge.

import { expect, spyOn, test } from 'bun:test';
import type { LinesOp, MoveOp, Rect } from '@workspace/lib/sheets/ops';
import type { BookRecords } from '../../../engine/book/records';
import { LAST_COLUMN, LAST_ROW, storeOf } from './records-fixtures';

const CASES = 100;
const STEPS = 6;
// Rows where a band of some size ends, and the grid's last rows.
const EDGES = [0, 63, 64, 127, 128, 4095, 4096, 65536, 524287, 524288, LAST_ROW - 200, LAST_ROW - 64, LAST_ROW];
const HEIGHTS = [1, 2, 3, 63, 64, 65, 127, 128, 129, 1000, 4096, 4097, 524288, 524289];

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
const below = (random: Random, n: number) => Math.floor(random() * n);
const pick = <T>(random: Random, list: readonly T[]): T => list[below(random, list.length)];
const clamp = (value: number, last: number) => Math.max(0, Math.min(last, value));

const meets = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const within = (inner: Rect, outer: Rect) =>
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
const inPlaceOrder = (rects: Rect[]) => rects.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

function rowOn(random: Random): number {
    return clamp(pick(random, EDGES) + below(random, 7) - 3, LAST_ROW);
}

function columnOn(random: Random): number {
    return random() < 0.8 ? below(random, 10) : LAST_COLUMN - below(random, 10);
}

function rectOn(random: Random, merges: readonly Rect[]): Rect {
    const roll = random();
    const [top, left] = [rowOn(random), columnOn(random)];
    if (roll < 0.15) return [0, left, LAST_ROW, clamp(left + below(random, 2), LAST_COLUMN)];
    if (roll < 0.3) return [top, 0, clamp(top + below(random, 3), LAST_ROW), LAST_COLUMN];
    if (roll < 0.55 && merges.length > 0) {
        // The shape of a merge that is there, beside it or below it, touching or a cell apart.
        const [t, l, b, r] = pick(random, merges);
        const gap = 1 + below(random, 2);
        const [down, right] = random() < 0.5 ? [b - t + gap, 0] : [0, r - l + gap];
        return [
            clamp(t + down, LAST_ROW),
            clamp(l + right, LAST_COLUMN),
            clamp(b + down, LAST_ROW),
            clamp(r + right, LAST_COLUMN),
        ];
    }
    return [top, left, clamp(top + pick(random, HEIGHTS) - 1, LAST_ROW), clamp(left + below(random, 4), LAST_COLUMN)];
}

function mergesOn(random: Random): Record<string, { rect: Rect }> {
    const merges: Record<string, { rect: Rect }> = {};
    const rects: Rect[] = [];
    for (let i = 0; i < 14; i += 1) {
        const rect = rectOn(random, rects);
        if (rects.some((other) => meets(other, rect))) continue;
        rects.push(rect);
        merges[`m${i}`] = { rect };
    }
    return merges;
}

const rectsOf = (store: BookRecords): Rect[] => [...store.records('S', 'merge').values()].map(({ rect }) => rect);

// Every read of the index, at the cells and rectangles on and around each merge, against the records themselves.
function expectIndexReads(store: BookRecords, random: Random): void {
    const rects = rectsOf(store);
    for (const [i, a] of rects.entries()) {
        for (const b of rects.slice(i + 1)) expect({ a, b, meet: meets(a, b) }).toEqual({ a, b, meet: false });
    }
    const cells: [number, number][] = [];
    const queries: Rect[] = [[0, 0, LAST_ROW, LAST_COLUMN]];
    for (const [top, left, bottom, right] of rects) {
        for (const row of [top - 1, top, top + 1, (top + bottom) >> 1, bottom - 1, bottom, bottom + 1]) {
            for (const column of [left - 1, left, right, right + 1]) {
                cells.push([clamp(row, LAST_ROW), clamp(column, LAST_COLUMN)]);
            }
        }
        queries.push(
            [top, left, bottom, right],
            [bottom, right, bottom, right],
            [clamp(top - 1, LAST_ROW), 0, clamp(top - 1, LAST_ROW), LAST_COLUMN],
            [clamp(bottom + 1, LAST_ROW), 0, clamp(bottom + 1, LAST_ROW), LAST_COLUMN],
            [bottom, clamp(right + 1, LAST_COLUMN), clamp(bottom + 70, LAST_ROW), LAST_COLUMN],
            [clamp(top - 70, LAST_ROW), 0, top, clamp(left - 1, LAST_COLUMN)],
        );
    }
    for (let i = 0; i < 6; i += 1) {
        cells.push([rowOn(random), columnOn(random)]);
        const [top, left] = [rowOn(random), columnOn(random)];
        queries.push([
            top,
            left,
            clamp(top + pick(random, HEIGHTS), LAST_ROW),
            clamp(left + below(random, 6), LAST_COLUMN),
        ]);
    }
    const column = columnOn(random);
    queries.push([0, column, LAST_ROW, column]);
    for (const [row, column] of cells) {
        const expected = rects.find((rect) => meets(rect, [row, column, row, column]));
        expect({ row, column, merge: store.merge('S', row, column) }).toEqual({ row, column, merge: expected });
    }
    for (const query of queries) {
        const expected = inPlaceOrder(rects.filter((rect) => meets(rect, query)));
        expect({ query, merges: store.mergesIn('S', query) }).toEqual({ query, merges: expected });
        expect({ query, touches: store.touchesMerge('S', query) }).toEqual({ query, touches: expected.length > 0 });
    }
}

// A record write, with the refusal and the records the model expects.
function writeMerge(store: BookRecords, random: Random, step: number): void {
    const before = new Map([...store.records('S', 'merge')].map(([id, { rect }]) => [id, rect]));
    const ids = [...before.keys()];
    const roll = random();
    const id = roll < 0.4 || ids.length === 0 ? `w${step}` : pick(random, ids);
    if (roll > 0.85) {
        store.write({ kind: 'record', sheet: 'S', type: 'merge', id });
        before.delete(id);
    } else {
        const rect = rectOn(random, [...before.values()]);
        const whole = random() < 0.5;
        const written = whole
            ? store.write({ kind: 'record', sheet: 'S', type: 'merge', id, set: { rect }, whole: 1 })
            : store.write({ kind: 'record', sheet: 'S', type: 'merge', id, set: { rect } });
        const taken = [...before].some(([other, held]) => other !== id && meets(held, rect));
        const skipped = !whole && !before.has(id);
        expect({ rect, refused: written === 'merge-overlap' }).toEqual({ rect, refused: taken && !skipped });
        if (!taken && !skipped) before.set(id, rect);
    }
    expect(new Map([...store.records('S', 'merge')].map(([key, { rect }]) => [key, rect]))).toEqual(before);
}

function editLines(store: BookRecords, random: Random): void {
    const rows = random() < 0.6;
    const last = rows ? LAST_ROW : LAST_COLUMN;
    const count = pick(random, [1, 2, 3, 64, 100, 5000]);
    const index = clamp((rows ? rowOn(random) : columnOn(random)) - below(random, 3), last + 1 - count);
    const edit: LinesOp = { kind: 'lines', insert: random() < 0.5, index, count, sheet: 'S', rows };
    if (edit.insert && store.wouldPush(edit)) return;
    const plan = store.planLines(edit);
    if (typeof plan === 'string') throw new Error(plan);
    plan.commit();
}

// A move on the sheet, with the refusal and the merges the model expects.
function moveBlock(store: BookRecords, random: Random): void {
    const before = rectsOf(store);
    const from = random() < 0.6 && before.length > 0 ? pick(random, before) : rectOn(random, before);
    const height = from[2] - from[0];
    const width = from[3] - from[1];
    const toRow = clamp(rowOn(random), LAST_ROW - height);
    const toColumn = clamp(columnOn(random), LAST_COLUMN - width);
    const op: MoveOp = { kind: 'move', sheet: 'S', from, toSheet: 'S', toRow, toColumn };
    const target: Rect = [toRow, toColumn, toRow + height, toColumn + width];
    const carried = before.filter((rect) => meets(rect, from));
    const landedOn = before.filter((rect) => meets(rect, target) && !carried.includes(rect));
    const cut = carried.some((rect) => !within(rect, from)) || landedOn.some((rect) => !within(rect, target));
    const plan = store.planMove(op);
    expect({ op, refused: plan }).toEqual({ op, refused: cut ? 'merge-cut' : expect.any(Object) });
    if (typeof plan === 'string') return;
    plan.commit();
    const shift = (rect: Rect): Rect => [
        rect[0] + toRow - from[0],
        rect[1] + toColumn - from[1],
        rect[2] + toRow - from[0],
        rect[3] + toColumn - from[1],
    ];
    const after = before
        .filter((rect) => !landedOn.includes(rect))
        .map((rect) => (carried.includes(rect) ? shift(rect) : rect));
    expect({ op, merges: inPlaceOrder(rectsOf(store)) }).toEqual({ op, merges: inPlaceOrder(after) });
}

test('the index reads as the records do, through writes, line edits and moves', () => {
    const random = randomFrom(23);
    const kinds = { tall: 0, wide: 0, touching: 0 };
    for (let i = 0; i < CASES; i += 1) {
        const store = storeOf({ merge: mergesOn(random) });
        const rects = rectsOf(store);
        if (rects.some((rect) => rect[0] === 0 && rect[2] === LAST_ROW)) kinds.tall += 1;
        if (rects.some((rect) => rect[1] === 0 && rect[3] === LAST_COLUMN)) kinds.wide += 1;
        if (rects.some((a) => rects.some((b) => a !== b && meets([a[0], a[1], a[2] + 1, a[3] + 1], b)))) {
            kinds.touching += 1;
        }
        expectIndexReads(store, random);
        for (let step = 0; step < STEPS; step += 1) {
            const roll = random();
            if (roll < 0.4) writeMerge(store, random, step);
            else if (roll < 0.8) editLines(store, random);
            else moveBlock(store, random);
            expectIndexReads(store, random);
        }
    }
    expect(kinds.tall).toBeGreaterThan(CASES / 5);
    expect(kinds.wide).toBeGreaterThan(CASES / 5);
    expect(kinds.touching).toBeGreaterThan(CASES / 2);
});

test('the index of a merge costs the same whatever its height or width', () => {
    const count = 1000;
    const built = (rectOf: (index: number) => Rect): number => {
        const merge = Object.fromEntries(
            Array.from({ length: count }, (_, index) => [`m${index}`, { rect: rectOf(index) }]),
        );
        const sets = spyOn(Map.prototype, 'set');
        const store = storeOf({ merge });
        const writes = sets.mock.calls.length;
        sets.mockRestore();
        expect(store.records('S', 'merge').size).toBe(count);
        return writes;
    };
    const small = built((index) => [0, index, 1, index]);
    expect(small).toBeLessThan(8 * count);
    expect(built((index) => [0, index, LAST_ROW, index])).toBeLessThanOrEqual(small);
    expect(built((index) => [index * 2, 0, index * 2, LAST_COLUMN])).toBeLessThanOrEqual(small);
    expect(built((index) => [63, index, 64, index])).toBeLessThanOrEqual(2 * small);
});
