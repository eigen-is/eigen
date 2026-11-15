// The law the applier leans on, over random records: a line edit, then its inverse edit, then the record ops the edit
// returned give back every record deep-equal; a move, the reverse move and its record ops do the same. Records sit
// near the grid's first lines and near its last, so open ranges and pushed lines come up often. Every record op the
// stores hand back on the way reads back through the batch validator.

import { expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { LinesOp, MoveOp, RecordOp, Rect, SheetContent, SheetFields, Span } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { SheetRecords } from '../../../engine/book/records';
import {
    applyRecordOps,
    chartOf,
    contentOf,
    editLines,
    formulaRule,
    inverseOf,
    keyOf,
    moveBlock,
    ref,
    reverseOf,
    sheetNamed,
    sheetOf,
} from './records-fixtures';

const CASES = 1500;
const FORMULAS = ['=A1>0', '=$C$3+B2', '=SUM(A1:B4)', '=T!A2*2', '=S!$B$5', '=A1:A3', '=R1+$A2'];

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

// A line near the start of the axis or near its end.
function lineOn(random: Random, lines: number): number {
    return random() < 0.7 ? below(random, 12) : lines - 1 - below(random, 12);
}

function spanOn(random: Random, lines: number): Span {
    const roll = random();
    if (roll < 0.1) return [0, lines - 1];
    const start = lineOn(random, lines);
    const end = roll < 0.3 ? lines - 1 : Math.min(lines - 1, start + below(random, 5));
    return [start, end];
}

function rectOn(random: Random): Rect {
    const [top, bottom] = spanOn(random, GRID_ROWS);
    const [left, right] = spanOn(random, GRID_COLUMNS);
    return [top, left, bottom, right];
}
const meets = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function recordsOn(random: Random, id: string): { records: SheetContent['records']; fields: Partial<SheetFields> } {
    const records: SheetContent['records'] = {
        merge: {},
        comment: {},
        conditionalFormat: {},
        validation: {},
        chart: {},
    };
    const merges: Rect[] = [];
    for (let i = below(random, 5); i > 0; i -= 1) {
        const [top, left] = [lineOn(random, GRID_ROWS), lineOn(random, GRID_COLUMNS)];
        const rect: Rect = [
            top,
            left,
            Math.min(GRID_ROWS - 1, top + below(random, 3)),
            Math.min(GRID_COLUMNS - 1, left + below(random, 3)),
        ];
        if (merges.some((other) => meets(other, rect))) continue;
        merges.push(rect);
        records.merge = { ...records.merge, [`${id}m${i}`]: { rect } };
    }
    for (let i = below(random, 5); i > 0; i -= 1) {
        records.comment = {
            ...records.comment,
            [`${id}c${i}`]: { row: lineOn(random, GRID_ROWS), column: lineOn(random, GRID_COLUMNS) },
        };
    }
    if (random() < 0.6) {
        const rect = rectOn(random);
        records.filter = { f: { rect } };
        records.filterColumn = {};
        for (let column = rect[1]; column <= Math.min(rect[3], rect[1] + 2); column += 1) {
            if (random() < 0.5) continue;
            const first = spanOn(random, GRID_ROWS);
            const rows: Span[] =
                first[1] < GRID_ROWS - 3 && random() < 0.5 ? [first, [first[1] + 2, first[1] + 2]] : [first];
            records.filterColumn[`k${column}`] = { filter: 'f', column, rows };
        }
    }
    for (let i = below(random, 4); i > 0; i -= 1) {
        const ranges = Array.from({ length: 1 + below(random, 2) }, () => rectOn(random));
        const formula = FORMULAS[below(random, FORMULAS.length)];
        records.conditionalFormat = {
            ...records.conditionalFormat,
            [`r${i}`]: formulaRule(ranges, keyOf(formula, ranges[0][0], ranges[0][1])),
        };
    }
    for (let i = below(random, 3); i > 0; i -= 1) {
        const ranges = Array.from({ length: 1 + below(random, 2) }, () => rectOn(random));
        const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
        records.validation = { ...records.validation, [`v${i}`]: { ranges, order: `a${i}`, rule } };
    }
    if (random() < 0.5) {
        const on = () => (random() < 0.5 ? 'S' : 'T');
        const [top, left, bottom, right] = rectOn(random);
        const values = ref(on(), [top, bottom], [left, right]);
        records.chart = {
            c: chartOf({ categories: random() < 0.5 ? values : null, series: [{ id: 's', name: 'n', values }] }),
        };
    }
    const fields = id === 'S' ? { frozenRows: below(random, 8), frozenColumns: below(random, 4) } : {};
    return { records, fields };
}

function bookOn(random: Random) {
    const s = recordsOn(random, 'S');
    const t = recordsOn(random, 'T');
    return () =>
        new Map([
            ['S', sheetOf(structuredClone(s.records), s.fields)],
            ['T', sheetOf(structuredClone(t.records), t.fields, 'T')],
        ]);
}

function expectSame(sheets: ReadonlyMap<string, SheetRecords>, before: ReadonlyMap<string, SheetRecords>) {
    for (const id of ['S', 'T']) expect(contentOf(sheetNamed(sheets, id))).toEqual(contentOf(sheetNamed(before, id)));
}

type Case = { build: () => Map<string, SheetRecords>; run: (sheets: ReadonlyMap<string, SheetRecords>) => RecordOp[] };

// The line edits the law holds for: the applier refuses an insert that would push a record off the grid, and an edit
// that would make a key too long. The case runs the edit and then its inverse, returning the edit's record ops.
function* lineCases(): Generator<Case> {
    const random = randomFrom(7);
    for (let i = 0; i < CASES; i += 1) {
        const build = bookOn(random);
        const rows = random() < 0.5;
        const lines = rows ? GRID_ROWS : GRID_COLUMNS;
        const count = 1 + below(random, 4);
        const index = Math.min(lineOn(random, lines), lines - count);
        const edit: LinesOp = {
            kind: 'lines',
            insert: random() < 0.5,
            index,
            count,
            sheet: random() < 0.8 ? 'S' : 'T',
            rows,
        };
        const sheets = build();
        if (edit.insert && sheetNamed(sheets, edit.sheet).wouldPush(edit)) continue;
        if ([...sheets.values()].some((sheet) => sheet.planLines(edit) === 'key-too-long')) continue;
        yield {
            build,
            run: (sheets) => {
                const restore = editLines(sheets.values(), edit);
                if (!edit.insert)
                    expect(sheetNamed(sheets, edit.sheet).wouldPush({ ...edit, insert: true })).toBe(false);
                editLines(sheets.values(), inverseOf(edit));
                return restore;
            },
        };
    }
}

function* moveCases(): Generator<Case> {
    const random = randomFrom(11);
    for (let i = 0; i < CASES; i += 1) {
        const build = bookOn(random);
        const [top, left] = [below(random, 12), below(random, 12)];
        const from: Rect = [top, left, top + below(random, 4), left + below(random, 4)];
        const op: MoveOp = {
            kind: 'move',
            sheet: 'S',
            from,
            toSheet: random() < 0.7 ? 'S' : 'T',
            toRow: below(random, 12),
            toColumn: below(random, 12),
        };
        const sheets = build();
        const source = sheetNamed(sheets, 'S');
        if ([...sheets.values()].some((sheet) => typeof sheet.planMove(op, source) === 'string')) continue;
        yield {
            build,
            run: (sheets) => {
                const restore = moveBlock(sheets, op);
                moveBlock(sheets, reverseOf(op));
                return restore;
            },
        };
    }
}

// Runs a case through the law and returns every record op the stores handed back: the edit's, then the inverses of
// its record ops as they were applied.
function holds({ build, run }: Case): RecordOp[] {
    const sheets = build();
    const restore = run(sheets);
    const inverses = applyRecordOps(sheets, build(), restore);
    expectSame(sheets, build());
    return [...restore, ...inverses];
}

test('a line edit, its inverse and its record ops give back every record', () => {
    let checked = 0;
    for (const lineCase of lineCases()) {
        holds(lineCase);
        checked += 1;
    }
    expect(checked).toBeGreaterThan(CASES / 2);
});

test('a move, the reverse move and its record ops give back every record', () => {
    let checked = 0;
    for (const moveCase of moveCases()) {
        holds(moveCase);
        checked += 1;
    }
    expect(checked).toBeGreaterThan(CASES / 3);
});

test('every record op the stores hand back reads back from a batch', () => {
    let read = 0;
    for (const lawCase of [...lineCases(), ...moveCases()]) {
        for (const op of holds(lawCase)) {
            expect({ op, read: readBatch(JSON.stringify({ g: 1, now: 0, seed: 0, ops: [op] })) !== null }).toEqual({
                op,
                read: true,
            });
            read += 1;
        }
    }
    expect(read).toBeGreaterThan(CASES);
});
