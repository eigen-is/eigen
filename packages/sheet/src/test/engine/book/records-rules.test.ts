// The reads by cell and by rectangle of rules and comments against a walk of the records themselves: over random
// validations and conditional formats whose ranges overlap, of every shape, and comments that share cells, the
// validation and the comments of a cell and the conditional formats of a rectangle read as the walk does, before and
// after record writes, line edits and moves.

import { describe, expect, test } from 'bun:test';
import type { DataValidationRule } from '@workspace/lib/sheets';
import { compareRules } from '@workspace/lib/sheets';
import type { ConditionalFormatRecord, LinesOp, MoveOp, Rect, ValidationRecord } from '@workspace/lib/sheets/ops';
import type { SheetRecords } from './records-fixtures';
import { LAST_COLUMN, LAST_ROW, planned, rowsAt, sheetOf } from './records-fixtures';

const CASES = 120;
const STEPS = 6;
const RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const ROW_EDGES = [0, 15, 16, 31, 32, 63, 64, 4095, 4096, 524288, LAST_ROW - 40, LAST_ROW];
const COLUMN_EDGES = [0, 3, 4, 7, 8, 15, 16, 8192, LAST_COLUMN - 9, LAST_COLUMN];
const SIZES = [1, 1, 2, 8, 9, 32, 33, 64, 65, 5000];
const ORDERS = ['a0', 'a1', 'a1', 'a2', 'a3'];

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
const rowOn = (random: Random) => clamp(pick(random, ROW_EDGES) + below(random, 5) - 2, LAST_ROW);
const columnOn = (random: Random) => clamp(pick(random, COLUMN_EDGES) + below(random, 5) - 2, LAST_COLUMN);

function rectOn(random: Random): Rect {
    const roll = random();
    const [top, left] = [rowOn(random), columnOn(random)];
    if (roll < 0.1) return [0, left, LAST_ROW, left];
    if (roll < 0.2) return [top, 0, top, LAST_COLUMN];
    if (roll < 0.25) return [0, 0, LAST_ROW, LAST_COLUMN];
    if (roll < 0.3) return [top, left, LAST_ROW, left];
    if (roll < 0.5) return [below(random, 70), below(random, 20), below(random, 70) + 70, below(random, 20) + 20];
    return [
        top,
        left,
        clamp(top + pick(random, SIZES) - 1, LAST_ROW),
        clamp(left + pick(random, SIZES) - 1, LAST_COLUMN),
    ];
}

const rangesOn = (random: Random): Rect[] => Array.from({ length: 1 + below(random, 4) }, () => rectOn(random));
const validationOn = (random: Random): ValidationRecord => ({
    ranges: rangesOn(random),
    order: pick(random, ORDERS),
    rule: RULE,
});
const formatOn = (random: Random): ConditionalFormatRecord => ({
    type: 'dataBar',
    format: ['#ff0000'],
    ranges: rangesOn(random),
    order: pick(random, ORDERS),
});
const commentOn = (random: Random) => ({ row: below(random, 3) * 32, column: below(random, 3) * 8 });

function sheetOn(random: Random): SheetRecords {
    const some = <R>(prefix: string, make: () => R) =>
        Object.fromEntries(Array.from({ length: 2 + below(random, 6) }, (_, i) => [`${prefix}${i}`, make()]));
    return sheetOf({
        validation: some('v', () => validationOn(random)),
        conditionalFormat: some('f', () => formatOn(random)),
        comment: some('c', () => commentOn(random)),
    });
}

// The reads at the cells and rectangles on and around every range and comment, against the records.
function expectReads(sheet: SheetRecords, random: Random): void {
    const validations = [...sheet.records('validation')];
    const formats = [...sheet.records('conditionalFormat')];
    const comments = [...sheet.records('comment')];
    const cells: [number, number][] = comments.map(([, { row, column }]) => [row, column]);
    const queries: Rect[] = [
        [0, 0, LAST_ROW, LAST_COLUMN],
        [0, 0, 60, 30],
    ];
    for (const [, { ranges }] of [...validations, ...formats]) {
        const [top, left, bottom, right] = pick(random, ranges);
        for (const row of [top - 1, top, bottom, bottom + 1]) {
            for (const column of [left - 1, left, right, right + 1]) {
                cells.push([clamp(row, LAST_ROW), clamp(column, LAST_COLUMN)]);
            }
        }
        queries.push(
            [top, left, bottom, right],
            [clamp(bottom + 1, LAST_ROW), 0, clamp(bottom + 40, LAST_ROW), LAST_COLUMN],
            [clamp(top - 40, LAST_ROW), clamp(left - 20, LAST_COLUMN), top, left],
        );
    }
    const [row, column] = [below(random, 80), below(random, 30)];
    for (let r = row; r < row + 8; r += 1) for (let c = column; c < column + 8; c += 1) cells.push([r, c]);
    for (let i = 0; i < 6; i += 1) {
        const [top, left] = [rowOn(random), columnOn(random)];
        cells.push([top, left]);
        queries.push([top, left, clamp(top + pick(random, SIZES), LAST_ROW), clamp(left + 30, LAST_COLUMN)]);
    }
    for (const [row, column] of cells) {
        const cell: Rect = [row, column, row, column];
        const covering = validations
            .filter(([, { ranges }]) => ranges.some((range) => meets(range, cell)))
            .sort(([idA, a], [idB, b]) => compareRules(a.order, idA, b.order, idB));
        expect({ row, column, rule: sheet.validation(row, column) }).toEqual({
            row,
            column,
            rule: covering.at(-1)?.[1],
        });
        const ids = comments.filter(([, at]) => at.row === row && at.column === column).map(([id]) => id);
        expect({ row, column, ids: sheet.comments(row, column) }).toEqual({ row, column, ids: ids.sort() });
    }
    const sorted = (ranges: readonly Rect[]) => ranges.map((range) => range.join(',')).sort();
    for (const query of queries) {
        const expected = formats
            .sort(([idA, a], [idB, b]) => compareRules(a.order, idA, b.order, idB))
            .map(([id, rule]) => ({ id, rule, ranges: sorted(rule.ranges.filter((range) => meets(range, query))) }))
            .filter(({ ranges }) => ranges.length > 0);
        const found = sheet
            .rulesIn('conditionalFormat', query)
            .map((entry) => ({ ...entry, ranges: sorted(entry.ranges) }));
        expect({ query, found }).toEqual({ query, found: expected });
        for (const { id, rule } of found) expect(sheet.records('conditionalFormat').get(id)).toBe(rule);
    }
}

function writeRecord(sheet: SheetRecords, random: Random, step: number): void {
    const idOf = (type: 'validation' | 'conditionalFormat' | 'comment') => {
        const ids = [...sheet.records(type).keys()];
        return random() < 0.35 || ids.length === 0 ? `w${step}` : pick(random, ids);
    };
    const base = { kind: 'record', sheet: 'S' } as const;
    const writes = [
        () => sheet.write({ ...base, type: 'validation', id: idOf('validation') }),
        () => sheet.write({ ...base, type: 'validation', id: idOf('validation'), set: validationOn(random), whole: 1 }),
        () => sheet.write({ ...base, type: 'validation', id: idOf('validation'), set: { ranges: rangesOn(random) } }),
        () =>
            sheet.write({ ...base, type: 'validation', id: idOf('validation'), set: { order: pick(random, ORDERS) } }),
        () => sheet.write({ ...base, type: 'conditionalFormat', id: idOf('conditionalFormat') }),
        () =>
            sheet.write({
                ...base,
                type: 'conditionalFormat',
                id: idOf('conditionalFormat'),
                set: formatOn(random),
                whole: 1,
            }),
        () => sheet.write({ ...base, type: 'comment', id: idOf('comment') }),
        () => sheet.write({ ...base, type: 'comment', id: idOf('comment'), set: commentOn(random), whole: 1 }),
        () => sheet.write({ ...base, type: 'comment', id: idOf('comment'), set: { row: below(random, 3) * 32 } }),
    ];
    pick(random, writes)();
}

function editLines(sheet: SheetRecords, random: Random): void {
    const rows = random() < 0.6;
    const last = rows ? LAST_ROW : LAST_COLUMN;
    const count = pick(random, [1, 2, 31, 32, 100, 5000]);
    const index = clamp((rows ? rowOn(random) : columnOn(random)) - below(random, 3), last + 1 - count);
    const edit: LinesOp = { kind: 'lines', insert: random() < 0.5, index, count, sheet: 'S', rows };
    if (edit.insert && sheet.wouldPush(edit)) return;
    planned(sheet.planLines(edit)).commit();
}

// A move on the sheet of a block around a range or a comment, with the ranges the model expects.
function moveBlock(sheet: SheetRecords, random: Random): void {
    const ranges = [...sheet.records('validation').values()].flatMap((rule) => rule.ranges);
    const from: Rect = random() < 0.7 && ranges.length > 0 ? pick(random, ranges) : [0, 0, 70, 20];
    const [height, width] = [from[2] - from[0], from[3] - from[1]];
    const toRow = clamp(rowOn(random), LAST_ROW - height);
    const toColumn = clamp(columnOn(random), LAST_COLUMN - width);
    const op: MoveOp = { kind: 'move', sheet: 'S', from, toSheet: 'S', toRow, toColumn };
    const shift = (range: Rect): Rect =>
        within(range, from)
            ? [
                  range[0] + toRow - from[0],
                  range[1] + toColumn - from[1],
                  range[2] + toRow - from[0],
                  range[3] + toColumn - from[1],
              ]
            : range;
    const after = [...sheet.records('validation')].map(([id, rule]) => [id, rule.ranges.map(shift)]);
    planned(sheet.planMove(op)).commit();
    expect([...sheet.records('validation')].map(([id, rule]) => [id, rule.ranges])).toEqual(after);
}

test('the reads of rules and comments are those of a walk of the records, through writes, line edits and moves', () => {
    const random = randomFrom(57);
    const steps = { write: 0, lines: 0, move: 0 };
    for (let i = 0; i < CASES; i += 1) {
        const sheet = sheetOn(random);
        expectReads(sheet, random);
        for (let step = 0; step < STEPS; step += 1) {
            const roll = random();
            if (roll < 0.4) writeRecord(sheet, random, step);
            else if (roll < 0.75) editLines(sheet, random);
            else moveBlock(sheet, random);
            steps[roll < 0.4 ? 'write' : roll < 0.75 ? 'lines' : 'move'] += 1;
            expectReads(sheet, random);
        }
    }
    for (const count of Object.values(steps)) expect(count).toBeGreaterThan(CASES);
});

describe('the conditional formats of a rectangle', () => {
    const rule = (order: string, ranges: Rect[]): ConditionalFormatRecord => ({
        type: 'dataBar',
        format: ['#ff0000'],
        ranges,
        order,
    });
    const sheet = () =>
        sheetOf({
            conditionalFormat: {
                late: rule('a2', [[0, 0, 9, 0]]),
                b: rule('a1', [[5, 0, 5, 5]]),
                a: rule('a1', [
                    [0, 0, 0, 0],
                    [100, 0, 100, 0],
                    [8, 2, 9, 3],
                ]),
                far: rule('a0', [[500, 0, LAST_ROW, 0]]),
            },
        });

    test('are the rules with a range in it, in rule order with ties by id, each with those ranges only', () => {
        const formats = sheet();
        expect(formats.rulesIn('conditionalFormat', [0, 0, 9, 9]).map(({ id, ranges }) => [id, ranges.length])).toEqual(
            [
                ['a', 2],
                ['b', 1],
                ['late', 1],
            ],
        );
        expect(formats.rulesIn('conditionalFormat', [100, 0, 100, 0])).toEqual([
            { id: 'a', rule: expect.objectContaining({ order: 'a1' }), ranges: [[100, 0, 100, 0]] },
        ]);
        expect(formats.rulesIn('conditionalFormat', [10, 0, 99, 9])).toEqual([]);
        expect(formats.rulesIn('conditionalFormat', [LAST_ROW, 0, LAST_ROW, 0]).map(({ id }) => id)).toEqual(['far']);
    });

    test('follow a replace, a delete, a line edit and a move', () => {
        const formats = sheet();
        const ids = (rect: Rect) => formats.rulesIn('conditionalFormat', rect).map(({ id }) => id);
        formats.write({ kind: 'record', sheet: 'S', type: 'conditionalFormat', id: 'late' });
        formats.write({
            kind: 'record',
            sheet: 'S',
            type: 'conditionalFormat',
            id: 'b',
            set: rule('a1', [[20, 0, 20, 0]]),
            whole: 1,
        });
        expect(ids([0, 0, 9, 9])).toEqual(['a']);
        expect(ids([20, 0, 20, 0])).toEqual(['b']);
        planned(formats.planLines(rowsAt(true, 10, 5))).commit();
        expect(ids([20, 0, 24, 0])).toEqual([]);
        expect(ids([25, 0, 25, 0])).toEqual(['b']);
        expect(ids([LAST_ROW, 0, LAST_ROW, 0])).toEqual(['far']);
        planned(formats.planLines(rowsAt(false, 0, 1))).commit();
        expect(formats.rulesIn('conditionalFormat', [0, 0, 8, 9]).map(({ ranges }) => ranges)).toEqual([
            [[7, 2, 8, 3]],
        ]);
        const op: MoveOp = { kind: 'move', sheet: 'S', from: [24, 0, 24, 0], toSheet: 'S', toRow: 40, toColumn: 9 };
        planned(formats.planMove(op)).commit();
        expect(ids([24, 0, 24, 0])).toEqual([]);
        expect(ids([40, 9, 40, 9])).toEqual(['b']);
    });
});

test('a comment is read at its cell through a line edit, and is gone with its line', () => {
    const sheet = sheetOf({ comment: { a: { row: 31, column: 7 }, b: { row: 32, column: 8 } } });
    planned(sheet.planLines(rowsAt(true, 32, 1))).commit();
    expect([sheet.comments(31, 7), sheet.comments(32, 8), sheet.comments(33, 8)]).toEqual([['a'], [], ['b']]);
    planned(sheet.planLines(rowsAt(false, 31, 1))).commit();
    expect([sheet.comments(31, 7), sheet.comments(32, 8), sheet.comments(33, 8)]).toEqual([[], ['b'], []]);
});
