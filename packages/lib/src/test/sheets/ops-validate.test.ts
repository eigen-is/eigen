import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS, MAX_STORED_LENGTH } from '@workspace/formula/text';
import { isRecord } from '../../core/guards';
import { MAX_BATCH_JSON, MAX_ID_LENGTH, MAX_ORDER_KEY, MAX_SHORT_TEXT, MAX_TEXT_LENGTH } from '../../sheets/limits';
import type { Batch, CellAttrKey, Op, SheetContent } from '../../sheets/ops';
import { LOOK_KEYS } from '../../sheets/ops';
import { isSheetContent, readBatch } from '../../sheets/ops-validate';

// A list whose first item is a hole, as JSON never writes one.
function holed(item: unknown): unknown[] {
    const list = new Array(2);
    list[1] = item;
    return list;
}

const CLOCK = { now: 46000.5, seed: -7 };
const batchOf = (...ops: unknown[]) => ({ g: 0, ...CLOCK, ops });
const accepts = (op: unknown) => readBatch(batchOf(op)) !== null;
const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;

const BOX = { index: 'a0', x: 0, y: 0, width: 10, height: 10 };
const RULE = { type: 'dropdown', type2: '', value1: 'A1:A5', value2: '' };
const SPEC = {
    ...{ specChart: '{}', specTitle: '{}', specLegend: '{}', specAxes: '{}' },
    ...{ specPlots: '{}', specSeries: '{}', specPoints: '{}', specData: '{}' },
};
const RANGE = { row: [0, 5], column: [0, 0] };

const input = (fields: object) => ({ kind: 'input', sheet: 's1', ...fields });
const cell = (content: unknown) => input({ cells: [[0, 0, content]] });
const record = (type: string, fields: object) => ({ kind: 'record', sheet: 's1', type, id: 'r1', ...fields });
const lines = (fields: object) => ({
    kind: 'lines',
    sheet: 's1',
    rows: true,
    insert: true,
    index: 5,
    count: 1,
    ...fields,
});
const added = (fields: object) => ({ kind: 'sheet', add: { ...SHEET, ...fields } });

const SHEET: SheetContent = {
    id: 's2',
    fields: { name: 'Sheet2', order: 'a1', frozenRows: 1, grid: 0, defaultColWidth: 80 },
    cells: [
        [0, 0, { v: 1 }],
        [3, 0, { f: '=A1*2', v: 2 }],
        [0, 1, { v: 'x', link: { type: 'webpage', address: 'https://eigen.is' }, qp: 1 }],
        [
            1,
            1,
            {
                s: [
                    { v: 'a', bl: 1 },
                    { v: 'b', fc: '#f00' },
                ],
            },
        ],
        [2, 1, { v: 3, spill: 1 }],
        [4, 1, { v: '#N/A', e: 1 }],
    ],
    looks: [{ bl: 1 }, { bg: '#eee', bdt: { style: 1, color: '#000' } }],
    bands: [0, 2, 0, 1, 10, 0, 3, 1, 0, 2, 5, 0],
    rows: [
        [[0, 0], { size: 30, custom: 1 }],
        [[4, 9], { hidden: 1 }],
    ],
    columns: [[[2, 2], { size: 120 }]],
    records: {
        merge: { m1: { rect: [0, 0, 1, 1] } },
        filter: { f1: { rect: [0, 0, 20, 4] } },
        filterColumn: {
            fc1: { filter: 'f1', column: 2, condition: { name: 'byValue', values: ['a'] }, rows: [[3, 3]] },
        },
        comment: { 'card-9': { row: 1, column: 1 } },
        conditionalFormat: {
            cf1: { ranges: [RANGE], order: 'a0', type: 'dataBar', format: ['#f00'] },
            cf2: {
                ranges: [RANGE],
                order: 'a1',
                type: 'default',
                format: { cellColor: '#f00', textColor: null },
                conditionName: 'formula',
                conditionValue: ['=A1>1'],
            },
        },
        validation: { v1: { ranges: [RANGE], order: 'a0', rule: RULE } },
        image: { i1: { ...BOX, mediaName: 'photo.png', angle: 15 } },
        chart: { c1: { ...BOX, ...SPEC, fill: '{"type":"solid"}', strokeStyle: 'dashed', seed: 3 } },
    },
};

// The examples of the vocabulary's design, as its writers would build them.
const but = (...kept: CellAttrKey[]) => LOOK_KEYS.filter((key) => !kept.includes(key));
const EXAMPLES: Batch[] = [
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', ranges: [[2, 1, 2, 1]], set: { fa: '0.0%' } },
            { kind: 'input', sheet: 's1', cells: [[2, 1, { v: 0.055 }]] },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', ranges: [[1, 1, 1, 1]], clear: ['fc', 'un'] },
            { kind: 'input', sheet: 's1', runs: [[[0, 0, 99, 2], null]] },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', ranges: [[1, 1, 1, 3]], set: { bdt: { style: 1, color: '#000' } } },
            { kind: 'format', sheet: 's1', ranges: [[4, 1, 4, 3]], set: { bdb: { style: 1, color: '#000' } } },
            { kind: 'format', sheet: 's1', ranges: [[1, 1, 4, 1]], set: { bdl: { style: 1, color: '#000' } } },
            { kind: 'format', sheet: 's1', ranges: [[1, 3, 4, 3]], set: { bdr: { style: 1, color: '#000' } } },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', lines: 'rows', spans: [[3, 8]], set: { hidden: 1 } },
            { kind: 'record', sheet: 's1', type: 'filter', id: 'f1', whole: 1, set: { rect: [0, 0, 20, 4] } },
            {
                kind: 'record',
                sheet: 's1',
                type: 'filterColumn',
                id: 'fc1',
                whole: 1,
                set: {
                    filter: 'f1',
                    column: 2,
                    rows: [
                        [3, 3],
                        [7, 8],
                    ],
                },
            },
            { kind: 'record', sheet: 's1', type: 'comment', id: 'card-9', whole: 1, set: { row: 1, column: 1 } },
            { kind: 'record', sheet: 's1', type: 'merge', id: 'm1', whole: 1, set: { rect: [0, 0, 1, 1] } },
            { kind: 'input', sheet: 's1', runs: [[[0, 0, 1, 1], null]], cells: [[0, 0, { v: 'kept' }]] },
            { kind: 'record', sheet: 's1', type: 'chart', id: 'c1', set: { fill: null, x: 10 } },
            { kind: 'record', sheet: 's1', type: 'sheet', id: 's1', set: { name: 'Sales', frozenRows: 1 } },
            { kind: 'record', sheet: 's1', type: 'image', id: 'i1' },
            { kind: 'lines', sheet: 's1', rows: true, insert: true, index: 5, count: 2, like: 4 },
            { kind: 'move', sheet: 's1', from: [0, 0, 3, 3], toSheet: 's2', toRow: 10, toColumn: 0 },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', ranges: [[0, 2, LAST_ROW, 2]], set: { bl: 1 } },
            { kind: 'format', sheet: 's1', ranges: [[4, 0, 4, LAST_COLUMN]], set: { bg: '#ff0' } },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'format', sheet: 's1', ranges: [[0, 3, 0, 4]], set: { bl: 1, bg: '#eee' }, clear: but('bl', 'bg') },
            { kind: 'format', sheet: 's1', ranges: [[1, 3, 1, 4]], clear: [...LOOK_KEYS] },
            {
                kind: 'input',
                sheet: 's1',
                runs: [[[0, 3, 1, 4], null]],
                cells: [
                    [0, 3, { v: 1 }],
                    [1, 3, { f: '=R[-1]C*2' }],
                    [0, 4, { v: 'x', link: { type: 'webpage', address: 'https://eigen.is' } }],
                ],
            },
        ],
    },
    {
        g: 0,
        ...CLOCK,
        ops: [
            { kind: 'input', sheet: 's1', runs: [[[1, 0, 100000, 0], { f: '=R[-1]C+1' }]] },
            { kind: 'format', sheet: 's1', ranges: [[1, 1, 1, 1]], clear: ['link', 'fc', 'un'] },
        ],
    },
    {
        g: 3,
        ...CLOCK,
        ops: [
            { kind: 'sheet', add: SHEET },
            { kind: 'sheet', delete: 's1' },
        ],
    },
];

describe('readBatch', () => {
    test('returns every example batch of the vocabulary', () => {
        for (const batch of EXAMPLES) expect(readBatch(batch)).toEqual(batch);
    });

    test('reads a batch from its JSON', () => {
        for (const batch of EXAMPLES) expect(readBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
    });

    test('refuses anything but { g, now, seed, ops }', () => {
        for (const value of [null, 1, 'x', [], {}, { g: 0 }, { ops: [] }, { ...CLOCK, ops: [] }, { g: 0, ops: [] }]) {
            expect(readBatch(value)).toBeNull();
        }
        expect(readBatch({ g: 0, ...CLOCK, ops: [], h: 1 })).toBeNull();
        for (const g of [-1, 1.5, Number.NaN, '0', null]) expect(readBatch({ g, ...CLOCK, ops: [] })).toBeNull();
        expect(readBatch({ g: 0, ...CLOCK, ops: {} })).toBeNull();
        expect(readBatch({ g: 0, ...CLOCK, ops: [] })).toEqual({ g: 0, ...CLOCK, ops: [] });
    });

    test('takes the clock as a serial and the seed as a 32-bit integer', () => {
        const clock = (now: unknown, seed: unknown) => readBatch({ g: 0, now, seed, ops: [] }) !== null;
        expect(clock(0, 0)).toBe(true);
        expect(clock(2958465.5, 2 ** 31 - 1)).toBe(true);
        expect(clock(1, -(2 ** 31))).toBe(true);
        for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1']) expect(clock(now, 0)).toBe(false);
        for (const seed of [2 ** 31, -(2 ** 31) - 1, 0.5, Number.NaN, '1']) expect(clock(0, seed)).toBe(false);
    });

    test('refuses a whole batch for one op that is not valid', () => {
        const [good] = EXAMPLES;
        expect(readBatch({ ...good, ops: [...good.ops, { kind: 'paste' }] })).toBeNull();
    });

    test('reads a hole in a sparse op list as an op that is not valid', () => {
        expect(readBatch({ g: 0, ...CLOCK, ops: holed(cell({ v: 1 })) })).toBeNull();
        expect(readBatch({ g: 0, ...CLOCK, ops: new Array(3) })).toBeNull();
    });
});

describe('1. ids', () => {
    test('are text of at most MAX_ID_LENGTH', () => {
        expect(accepts({ kind: 'sheet', delete: 'a'.repeat(MAX_ID_LENGTH) })).toBe(true);
        expect(accepts({ kind: 'sheet', delete: 'a'.repeat(MAX_ID_LENGTH + 1) })).toBe(false);
        expect(accepts({ kind: 'sheet', delete: '' })).toBe(false);
        expect(accepts({ kind: 'sheet', delete: 1 })).toBe(false);
        expect(accepts(record('merge', { id: 'b'.repeat(MAX_ID_LENGTH + 1) }))).toBe(false);
    });

    test('of a sheet hold no bracket', () => {
        for (const id of ['a[1', 'a]', '[']) {
            expect(accepts({ kind: 'sheet', delete: id })).toBe(false);
            expect(accepts(input({ sheet: id, cells: [[0, 0, null]] }))).toBe(false);
            expect(accepts(added({ id }))).toBe(false);
            expect(accepts({ kind: 'move', sheet: 's1', from: [0, 0, 0, 0], toSheet: id, toRow: 0, toColumn: 0 })).toBe(
                false,
            );
        }
        expect(accepts(record('merge', { id: 'a[1]', set: { rect: [0, 0, 1, 1] } }))).toBe(true);
    });

    test('are never a key that names an object prototype', () => {
        expect(accepts(record('merge', { id: '__proto__', set: { rect: [0, 0, 1, 1] } }))).toBe(false);
        const records = JSON.parse('{"merge":{"__proto__":{"rect":[0,0,1,1]}}}');
        expect(accepts(added({ records }))).toBe(false);
    });
});

describe('2. places', () => {
    test('are integers on the grid', () => {
        expect(accepts(input({ cells: [[LAST_ROW, LAST_COLUMN, null]] }))).toBe(true);
        for (const [row, column] of [
            [GRID_ROWS, 0],
            [0, GRID_COLUMNS],
            [-1, 0],
            [1.5, 0],
            [Number.NaN, 0],
            [Number.POSITIVE_INFINITY, 0],
            ['3', 0],
        ]) {
            expect(accepts(input({ cells: [[row, column, null]] }))).toBe(false);
        }
    });

    test('make ordered rectangles and spans', () => {
        expect(accepts({ kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]], set: { bl: 1 } })).toBe(true);
        expect(accepts({ kind: 'format', sheet: 's1', ranges: [[1, 0, 0, 0]], set: { bl: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', ranges: [[0, 1, 0, 0]], set: { bl: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', ranges: [[0, 0, 0]], set: { bl: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', lines: 'rows', spans: [[2, 1]], set: { hidden: 1 } })).toBe(
            false,
        );
        expect(
            accepts({ kind: 'format', sheet: 's1', lines: 'columns', spans: [[0, LAST_COLUMN]], set: { size: 9 } }),
        ).toBe(true);
        expect(
            accepts({ kind: 'format', sheet: 's1', lines: 'columns', spans: [[0, GRID_COLUMNS]], set: { size: 9 } }),
        ).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', lines: 'rows', spans: [[0, LAST_ROW]], set: { size: 9 } })).toBe(
            true,
        );
    });

    test('in a cell list are sorted by column then row, no place twice', () => {
        const sorted = [
            [1, 0, null],
            [0, 1, null],
            [5, 1, null],
        ];
        expect(accepts(input({ cells: sorted }))).toBe(true);
        expect(accepts(input({ cells: [sorted[1], sorted[0]] }))).toBe(false);
        expect(accepts(input({ cells: [sorted[2], sorted[1]] }))).toBe(false);
        expect(accepts(input({ cells: [sorted[0], sorted[0]] }))).toBe(false);
        expect(
            accepts(
                added({
                    cells: [
                        [1, 0, { v: 1 }],
                        [0, 0, { v: 2 }],
                    ],
                }),
            ),
        ).toBe(false);
    });

    test('in runs are disjoint rectangles', () => {
        const run = (rect: number[]) => [rect, null];
        expect(accepts(input({ runs: [run([0, 0, 1, 1]), run([2, 0, 3, 1]), run([0, 2, 3, 2])] }))).toBe(true);
        expect(accepts(input({ runs: [run([0, 0, 1, 1]), run([1, 1, 3, 3])] }))).toBe(false);
        expect(accepts(input({ runs: [run([0, 0, 9, 9]), run([3, 3, 4, 4])] }))).toBe(false);
        expect(accepts(input({ runs: [run([3, 0, 3, 9]), run([0, 5, 9, 5])] }))).toBe(false);
        expect(accepts(input({ runs: [run([0, 0, 0, 0]), run([0, 0, 0, 0])] }))).toBe(false);
    });

    test('in many runs are checked in about linear time', () => {
        const rows = Array.from({ length: 50_000 }, (_, row) => [[row, 0, row, LAST_COLUMN], null]);
        const started = performance.now();
        expect(accepts(input({ runs: rows }))).toBe(true);
        expect(accepts(input({ runs: [...rows, [[25_000, 7, 25_000, 7], null]] }))).toBe(false);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test('of a move keep the block on the grid', () => {
        const move = (toRow: number, toColumn: number) => ({
            kind: 'move',
            sheet: 's1',
            from: [0, 0, 9, 1],
            toSheet: 's1',
            toRow,
            toColumn,
        });
        expect(accepts(move(GRID_ROWS - 10, GRID_COLUMNS - 2))).toBe(true);
        expect(accepts(move(GRID_ROWS - 9, 0))).toBe(false);
        expect(accepts(move(0, GRID_COLUMNS - 1))).toBe(false);
    });
});

describe('3. closed shapes', () => {
    test('refuse a key the type does not list', () => {
        for (const extra of [{ m: '1' }, { ct: { t: 'n' } }, { mc: { r: 0, c: 0 } }, { bl: 1 }, { spill: 1 }]) {
            expect(accepts(cell({ v: 1, ...extra }))).toBe(false);
        }
        expect(accepts({ ...cell({ v: 1 }), path: ['data', 0, 0] })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]], set: { size: 9 } })).toBe(false);
        expect(
            accepts({
                kind: 'format',
                sheet: 's1',
                ranges: [[0, 0, 0, 0]],
                set: { bdt: { style: 1, color: '#000', w: 1 } },
            }),
        ).toBe(false);
        expect(accepts(record('merge', { set: { rect: [0, 0, 1, 1], extra: 1 } }))).toBe(false);
        expect(accepts(added({ fields: { name: 'S', order: 'a0', zoom: 1 } }))).toBe(false);
        expect(accepts({ ...added({}), extra: 1 })).toBe(false);
        expect(accepts({ kind: 'sheet', delete: 's1', extra: 1 })).toBe(false);
    });

    test('refuse a prototype key in place of a listed one', () => {
        expect(
            accepts(JSON.parse('{"kind":"input","sheet":"s1","cells":[[0,0,{"v":1,"__proto__":{"f":"=1"}}]]}')),
        ).toBe(false);
        expect(accepts(JSON.parse('{"kind":"sheet","delete":"s1","__proto__":{"add":{}}}'))).toBe(false);
    });

    test('refuse a kind or a record type that does not exist', () => {
        expect(accepts({ kind: 'cells', sheet: 's1' })).toBe(false);
        expect(accepts({ kind: 'result', sheet: 's1', cells: [] })).toBe(false);
        expect(accepts(record('table', { set: { rect: [0, 0, 1, 1] } }))).toBe(false);
        expect(accepts(record('toString', {}))).toBe(false);
    });
});

describe('4. values and formulas', () => {
    test('a value is a finite number, a boolean or text within the bound', () => {
        for (const v of [0, -2.5, 1e300, true, false, '', 'x'.repeat(MAX_TEXT_LENGTH)])
            expect(accepts(cell({ v }))).toBe(true);
        for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 'x'.repeat(MAX_TEXT_LENGTH + 1), null, [], {}, 10n]) {
            expect(accepts(cell({ v }))).toBe(false);
        }
    });

    test('an error is a known error literal beside e: 1', () => {
        expect(accepts(cell({ v: '#DIV/0!', e: 1 }))).toBe(true);
        expect(accepts(cell({ v: '#BUSY!', e: 1 }))).toBe(true);
        expect(accepts(cell({ v: '#div/0!', e: 1 }))).toBe(false);
        expect(accepts(cell({ v: 'oops', e: 1 }))).toBe(false);
        expect(accepts(cell({ v: 7, e: 1 }))).toBe(false);
        expect(accepts(cell({ e: 1 }))).toBe(false);
        expect(accepts(cell({ v: '#N/A', e: 2 }))).toBe(false);
        expect(accepts(cell({ v: '#N/A' }))).toBe(true);
    });

    test('a formula starts with = and is at most MAX_STORED_LENGTH, parsed or not', () => {
        expect(accepts(cell({ f: '=1' }))).toBe(true);
        expect(accepts(cell({ f: '=(' }))).toBe(true);
        expect(accepts(cell({ f: `=${'1'.repeat(MAX_STORED_LENGTH - 1)}` }))).toBe(true);
        expect(accepts(cell({ f: `=${'1'.repeat(MAX_STORED_LENGTH)}` }))).toBe(false);
        expect(accepts(cell({ f: '1' }))).toBe(false);
        expect(accepts(cell({ f: '' }))).toBe(false);
        expect(accepts(cell({ f: '=NOW()', v: 4, e: undefined }))).toBe(true);
        expect(accepts(cell({ f: '=1/0', v: '#DIV/0!', e: 1 }))).toBe(true);
    });

    test('rich text stands with neither a value nor a formula', () => {
        expect(
            accepts(cell({ s: [{ v: 'a' }, { v: 'b', bl: 1, it: 1, ff: 'Arial', fs: 11, fc: '#000', cl: 1, un: 1 }] })),
        ).toBe(true);
        expect(accepts(cell({ s: [{ v: 'a' }], v: 'a' }))).toBe(false);
        expect(accepts(cell({ s: [{ v: 'a' }], f: '=1' }))).toBe(false);
        expect(accepts(cell({ s: [{ v: 'a', bg: '#000' }] }))).toBe(false);
        expect(accepts(cell({ s: [{ bl: 1 }] }))).toBe(false);
        expect(accepts(cell({ s: [{ v: 'x'.repeat(MAX_TEXT_LENGTH) }, { v: 'y' }] }))).toBe(false);
    });

    test('a link and a quote prefix are content', () => {
        expect(accepts(cell({ v: 'x', link: { type: 'sheet', address: 's2' }, qp: 1 }))).toBe(true);
        expect(accepts(cell({ link: { type: 'email', address: 'a' } }))).toBe(false);
        expect(accepts(cell({ link: { type: 'webpage' } }))).toBe(false);
        expect(accepts(cell({ v: 'x', qp: true }))).toBe(false);
    });

    test('spill stands only in a sheet add, on a value with no formula', () => {
        expect(accepts(added({ cells: [[0, 0, { v: 1, spill: 1 }]] }))).toBe(true);
        expect(accepts(added({ cells: [[0, 0, { f: '=1', v: 1, spill: 1 }]] }))).toBe(false);
        expect(accepts(added({ cells: [[0, 0, { v: 1, spill: true }]] }))).toBe(false);
        expect(accepts(added({ cells: [[0, 0, { spill: 1 }]] }))).toBe(false);
        expect(accepts(cell({ v: 1, spill: 1 }))).toBe(false);
    });

    test('no op sends a result, since every reader computes a clock cell', () => {
        expect(accepts({ kind: 'result', sheet: 's1', cells: [[0, 0, { f: '=RAND()', v: 0.5 }]] })).toBe(false);
    });
});

describe('5. input', () => {
    test('has at least one entry in runs or cells', () => {
        expect(accepts(input({}))).toBe(false);
        expect(accepts(input({ runs: [], cells: [] }))).toBe(false);
        expect(accepts(input({ runs: [[[0, 0, 0, 0], { v: 1 }]] }))).toBe(true);
        expect(accepts(input({ cells: [[0, 0, null]] }))).toBe(true);
    });
});

describe('6. format', () => {
    test('has exactly one of ranges or lines with spans', () => {
        const both = {
            kind: 'format',
            sheet: 's1',
            ranges: [[0, 0, 0, 0]],
            lines: 'rows',
            spans: [[0, 0]],
            set: { bl: 1 },
        };
        expect(accepts(both)).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', set: { bl: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', lines: 'rows', set: { hidden: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', spans: [[0, 0]], set: { hidden: 1 } })).toBe(false);
        expect(accepts({ kind: 'format', sheet: 's1', lines: 'cols', spans: [[0, 0]], set: { hidden: 1 } })).toBe(
            false,
        );
    });

    test('names at least one key', () => {
        const cells = { kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]] };
        expect(accepts(cells)).toBe(false);
        expect(accepts({ ...cells, set: {} })).toBe(false);
        expect(accepts({ ...cells, clear: [] })).toBe(false);
        expect(accepts({ ...cells, set: {}, clear: ['bl'] })).toBe(true);
        expect(accepts({ ...cells, clear: ['link'] })).toBe(true);
        expect(accepts({ ...cells, clear: ['size'] })).toBe(false);
        expect(accepts({ ...cells, set: { link: { type: 'cellrange', address: 'A1' } } })).toBe(true);
        const spans = { kind: 'format', sheet: 's1', lines: 'rows', spans: [[0, 0]] };
        expect(accepts({ ...spans, set: {} })).toBe(false);
        expect(accepts({ ...spans, clear: ['custom', 'hidden'] })).toBe(true);
        expect(accepts({ ...spans, clear: ['bl'] })).toBe(false);
        expect(accepts({ ...spans, set: { size: -1 } })).toBe(false);
        expect(accepts({ ...spans, set: { hidden: 0 } })).toBe(false);
    });

    test('sets look keys of their own types', () => {
        const set = (look: unknown) => ({ kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]], set: look });
        const every = {
            ...{ bl: 1, it: 1, ff: 2, fs: 10, fc: '#123456', cl: 1, un: 1, fa: '0.00', ht: 1, vt: 2, tb: '2' },
            ...{ bg: 'rgb(1, 2, 3)', rt: 'vertical', bdt: { style: 13, color: '#fff' } },
        };
        expect(accepts(set(every))).toBe(true);
        expect(accepts(set({ rt: -90 }))).toBe(true);
        expect(accepts(set({ ff: 'Arial' }))).toBe(true);
        for (const bad of [
            { bl: 0 },
            { bl: true },
            { fs: '10' },
            { rt: 91 },
            { rt: 'up' },
            { fa: 'x'.repeat(MAX_SHORT_TEXT + 1) },
        ]) {
            expect(accepts(set(bad))).toBe(false);
        }
    });

    test('a border side is a known style ordinal and a color', () => {
        const side = (bdd: unknown) => ({ kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]], set: { bdd } });
        expect(accepts(side({ style: 1, color: '#000' }))).toBe(true);
        expect(accepts(side({ style: 7, color: 'rgba(0, 0, 0, 0.5)' }))).toBe(true);
        for (const bad of [
            { style: 0, color: '#000' },
            { style: 14, color: '#000' },
            { style: 'thin', color: '#000' },
            { style: 1.5, color: '#000' },
            { style: 1, color: 'black' },
            { style: 1, color: '#00' },
            { style: 1 },
            { color: '#000' },
        ]) {
            expect(accepts(side(bad))).toBe(false);
        }
    });
});

describe('7. sheet', () => {
    test('has exactly one of add and delete', () => {
        expect(accepts({ kind: 'sheet', add: SHEET, delete: 's1' })).toBe(false);
        expect(accepts({ kind: 'sheet' })).toBe(false);
        expect(accepts({ kind: 'sheet', delete: 's1' })).toBe(true);
        expect(accepts({ kind: 'sheet', add: SHEET })).toBe(true);
    });
});

describe('8. record', () => {
    test('whole needs set with every required field of its type, none null', () => {
        expect(accepts(record('merge', { whole: 1, set: { rect: [0, 0, 1, 1] } }))).toBe(true);
        expect(accepts(record('merge', { whole: 1, set: {} }))).toBe(false);
        expect(accepts(record('merge', { whole: 1 }))).toBe(false);
        expect(accepts(record('merge', { whole: 1, set: { rect: null } }))).toBe(false);
        expect(accepts(record('merge', { whole: 2, set: { rect: [0, 0, 1, 1] } }))).toBe(false);
        expect(accepts(record('image', { whole: 1, set: { ...BOX, mediaName: 'a.png', angle: null } }))).toBe(false);
        expect(accepts(record('chart', { whole: 1, set: { ...BOX, ...SPEC } }))).toBe(true);
        expect(accepts(record('chart', { whole: 1, set: { ...BOX, specData: '{}' } }))).toBe(false);
    });

    test('set without whole names at least one field, and null clears only an optional one', () => {
        expect(accepts(record('merge', { set: {} }))).toBe(false);
        expect(accepts(record('merge', { set: { rect: [0, 0, 1, 1] } }))).toBe(true);
        expect(accepts(record('merge', { set: { rect: null } }))).toBe(false);
        expect(accepts(record('image', { set: { angle: null } }))).toBe(true);
        expect(accepts(record('image', { set: { mediaName: null } }))).toBe(false);
        expect(accepts(record('chart', { set: { fill: null, x: 10 } }))).toBe(true);
        expect(accepts(record('filterColumn', { set: { condition: null } }))).toBe(true);
        expect(accepts(record('merge', {}))).toBe(true);
    });

    test('of type sheet names its own sheet, always with a set and never whole', () => {
        const sheet = { kind: 'record', sheet: 's1', type: 'sheet', id: 's1' };
        expect(accepts({ ...sheet, set: { name: 'Sales' } })).toBe(true);
        expect(accepts({ ...sheet, id: 's2', set: { name: 'Sales' } })).toBe(false);
        expect(accepts({ ...sheet, whole: 1, set: { name: 'Sales', order: 'a0' } })).toBe(false);
        expect(accepts(sheet)).toBe(false);
        expect(accepts({ ...sheet, set: { order: null } })).toBe(false);
        expect(accepts({ ...sheet, set: { color: null, hide: 1 } })).toBe(true);
        expect(accepts({ ...sheet, set: { frozenRows: GRID_ROWS + 1 } })).toBe(false);
    });

    test('a filter column names a well-formed filter, over sorted disjoint rows', () => {
        const column = (fields: object) =>
            record('filterColumn', { whole: 1, set: { filter: 'f1', column: 2, rows: [], ...fields } });
        expect(accepts(column({}))).toBe(true);
        expect(accepts(column({ filter: '' }))).toBe(false);
        expect(accepts(column({ filter: 'f'.repeat(MAX_ID_LENGTH + 1) }))).toBe(false);
        expect(accepts(column({ filter: 7 }))).toBe(false);
        expect(
            accepts(
                column({
                    rows: [
                        [3, 4],
                        [6, 6],
                    ],
                }),
            ),
        ).toBe(true);
        expect(
            accepts(
                column({
                    rows: [
                        [3, 4],
                        [4, 6],
                    ],
                }),
            ),
        ).toBe(false);
        expect(
            accepts(
                column({
                    rows: [
                        [6, 6],
                        [3, 4],
                    ],
                }),
            ),
        ).toBe(false);
        expect(accepts(column({ condition: { name: 'byValue', values: ['a', 1] } }))).toBe(false);
        expect(accepts(record('filterColumn', { set: { filter: '' } }))).toBe(false);
    });

    test('an order key is at most MAX_ORDER_KEY', () => {
        const order = (key: string) =>
            record('validation', { whole: 1, set: { ranges: [RANGE], order: key, rule: RULE } });
        expect(accepts(order('a0'))).toBe(true);
        expect(accepts(order('a'))).toBe(false);
        expect(accepts(order(`a${'V'.repeat(MAX_ORDER_KEY - 1)}`))).toBe(true);
        expect(accepts(order(`a${'V'.repeat(MAX_ORDER_KEY)}`))).toBe(false);
        expect(accepts(order(''))).toBe(false);
        expect(
            accepts({
                kind: 'record',
                sheet: 's1',
                type: 'sheet',
                id: 's1',
                set: { order: 'a'.repeat(MAX_ORDER_KEY + 1) },
            }),
        ).toBe(false);
    });

    test('a conditional format is one of its kinds whole, its formula a stored key', () => {
        const rule = (fields: object) =>
            record('conditionalFormat', { whole: 1, set: { ranges: [RANGE], order: 'a0', ...fields } });
        const formula = (conditionValue: unknown[]) =>
            rule({ type: 'default', format: {}, conditionName: 'formula', conditionValue });
        expect(accepts(rule({ type: 'colorGradation', format: ['#fff', 'rgb(0,0,0)'] }))).toBe(true);
        expect(accepts(rule({ type: 'colorGradation', format: ['#fff'], ranges: [] }))).toBe(false);
        expect(accepts(rule({ type: 'dataBar', format: { cellColor: '#f00' } }))).toBe(false);
        expect(accepts(rule({ type: 'default', format: ['#f00'], conditionName: 'equal', conditionValue: [1] }))).toBe(
            false,
        );
        expect(accepts(rule({ type: 'default', format: {}, conditionName: 'nearly', conditionValue: [1] }))).toBe(
            false,
        );
        expect(accepts(formula(['=A1>1']))).toBe(true);
        expect(accepts(formula(['A1>1']))).toBe(false);
        expect(accepts(formula([`=${'1'.repeat(MAX_STORED_LENGTH)}`]))).toBe(false);
    });

    test('a conditional format changes only whole, so a field edit never leaves a rule of no kind', () => {
        for (const set of [
            { format: { cellColor: '#0f0' } },
            { conditionValue: ['A1>1'] },
            { conditionName: 'formula' },
            { conditionValue: [6] },
            { type: 'dataBar' },
        ]) {
            expect(accepts(record('conditionalFormat', { set }))).toBe(false);
        }
        expect(accepts(record('conditionalFormat', {}))).toBe(true);
    });

    test('a validation keeps its dropdown source as text', () => {
        expect(accepts(record('validation', { set: { rule: RULE } }))).toBe(true);
        expect(accepts(record('validation', { set: { rule: { ...RULE, value1: 3 } } }))).toBe(false);
        expect(
            accepts(record('validation', { set: { rule: { ...RULE, hintShow: true, prohibitInput: false } } })),
        ).toBe(true);
        expect(accepts(record('validation', { set: { rule: { type: 'dropdown' } } }))).toBe(false);
    });

    test('an image names a media file and never a path', () => {
        expect(accepts(record('image', { set: { mediaName: 'a.png' } }))).toBe(true);
        for (const mediaName of ['', '../a.png', 'a/b.png', 'a\\b', 'a\nb']) {
            expect(accepts(record('image', { set: { mediaName } }))).toBe(false);
        }
    });

    test('a floating box is finite', () => {
        expect(accepts(record('image', { set: { x: Number.POSITIVE_INFINITY } }))).toBe(false);
        expect(accepts(record('chart', { set: { strokeStyle: 'wavy' } }))).toBe(false);
        expect(accepts(record('chart', { set: { index: '' } }))).toBe(false);
    });
});

describe('9. a sheet name', () => {
    test('follows Excel rule', () => {
        const rename = (name: unknown) => ({ kind: 'record', sheet: 's1', type: 'sheet', id: 's1', set: { name } });
        expect(accepts(rename('Q1 sales'))).toBe(true);
        expect(accepts(rename('x'.repeat(31)))).toBe(true);
        for (const name of ['', 'x'.repeat(32), 'a:b', 'a[1]', "'a", "a'", 'a/b', 'a?', 'a*', 'a\\b', 3]) {
            expect(accepts(rename(name))).toBe(false);
            expect(accepts(added({ fields: { name, order: 'a0' } }))).toBe(false);
        }
    });
});

describe('10. lines', () => {
    test('count is at least 1 and the lines end on the grid', () => {
        expect(accepts(lines({ count: 0 }))).toBe(false);
        expect(accepts(lines({ index: GRID_ROWS - 3, count: 3 }))).toBe(true);
        expect(accepts(lines({ index: GRID_ROWS - 3, count: 4 }))).toBe(false);
        expect(accepts(lines({ rows: false, index: GRID_COLUMNS - 1, count: 1 }))).toBe(true);
        expect(accepts(lines({ rows: false, index: GRID_COLUMNS, count: 1 }))).toBe(false);
        expect(accepts(lines({ index: -1 }))).toBe(false);
        expect(accepts(lines({ rows: 1 }))).toBe(false);
        expect(accepts(lines({ insert: 'yes' }))).toBe(false);
    });

    test('like stands only on an insert, as index − 1 or index', () => {
        expect(accepts(lines({ like: 4 }))).toBe(true);
        expect(accepts(lines({ like: 5 }))).toBe(true);
        expect(accepts(lines({ like: 6 }))).toBe(false);
        expect(accepts(lines({ like: 3 }))).toBe(false);
        expect(accepts(lines({ insert: false, like: 5 }))).toBe(false);
        expect(accepts(lines({ index: 0, like: -1 }))).toBe(false);
        expect(accepts(lines({ index: 0, like: 0 }))).toBe(true);
    });
});

describe('11. the batch budget', () => {
    test('refuses a batch past MAX_BATCH_JSON of JSON', () => {
        const text = 'x'.repeat(100_000);
        const count = Math.ceil(MAX_BATCH_JSON / text.length);
        const fits = Array.from({ length: count - 2 }, (_, row) => [row, 0, { v: text }]);
        expect(readBatch(batchOf(input({ cells: fits })))).not.toBeNull();
        const past = Array.from({ length: count + 1 }, (_, row) => [row, 0, { v: text }]);
        expect(readBatch(batchOf(input({ cells: past })))).toBeNull();
    });

    test('leaves a sheet add out of the count', () => {
        const text = 'x'.repeat(100_000);
        const count = Math.ceil(MAX_BATCH_JSON / text.length) + 1;
        const cells = Array.from({ length: count }, (_, row) => [row, 0, { v: text }]);
        expect(readBatch(batchOf(added({ cells })))).not.toBeNull();
    });
});

describe('the sheet content', () => {
    test('is valid whole', () => {
        expect(isSheetContent(SHEET)).toBe(true);
        expect(isSheetContent(JSON.parse(JSON.stringify(SHEET)))).toBe(true);
        expect(isSheetContent({ ...SHEET, records: {} })).toBe(true);
        expect(isSheetContent({ ...SHEET, looks: [], bands: [] })).toBe(true);
    });

    test('needs every one of its fields', () => {
        for (const key of Object.keys(SHEET)) {
            expect(isSheetContent(Object.fromEntries(Object.entries(SHEET).filter(([field]) => field !== key)))).toBe(
                false,
            );
        }
    });

    test('has well-formed bands: ascending, look indexes in range', () => {
        const bands = (list: number[]) => isSheetContent({ ...SHEET, bands: list });
        expect(bands([0, 0])).toBe(true);
        expect(bands([0, 1, 0, 2])).toBe(true);
        expect(bands([0, 1, 0, 3])).toBe(false);
        expect(bands([0, 1, 0, -1])).toBe(false);
        expect(bands([0, 2, 5, 1, 5, 2])).toBe(false);
        expect(bands([0, 2, 5, 1, 4, 2])).toBe(false);
        expect(bands([0, 1, GRID_ROWS, 1])).toBe(false);
        expect(bands([3, 0, 3, 0])).toBe(false);
        expect(bands([3, 0, 2, 0])).toBe(false);
        expect(bands([GRID_COLUMNS, 0])).toBe(false);
        expect(bands([0, 2, 0, 1])).toBe(false);
        expect(bands([0, 1, 0, 1, 7])).toBe(false);
        expect(bands([0, 1.5, 0, 1])).toBe(false);
        expect(bands([0, -1])).toBe(false);
    });

    test('has looks of the look keys only', () => {
        expect(isSheetContent({ ...SHEET, looks: [{ bl: 1 }, { v: 1 }] })).toBe(false);
        expect(isSheetContent({ ...SHEET, looks: [{ link: { type: 'sheet', address: 's1' } }] })).toBe(false);
    });

    test('has line runs ascending and disjoint', () => {
        const rows = (list: unknown) => isSheetContent({ ...SHEET, rows: list });
        expect(
            rows([
                [[0, 3], { size: 3 }],
                [[4, 4], { hidden: 1 }],
            ]),
        ).toBe(true);
        expect(
            rows([
                [[0, 3], { size: 3 }],
                [[3, 4], { hidden: 1 }],
            ]),
        ).toBe(false);
        expect(
            rows([
                [[4, 4], { size: 3 }],
                [[0, 3], { hidden: 1 }],
            ]),
        ).toBe(false);
        expect(rows([[[0, 3], { bl: 1 }]])).toBe(false);
        expect(isSheetContent({ ...SHEET, columns: [[[0, GRID_COLUMNS], { size: 3 }]] })).toBe(false);
    });

    test('has records by type, each whole', () => {
        const records = (list: unknown) => isSheetContent({ ...SHEET, records: list });
        expect(records({ sheet: { s2: { name: 'a', order: 'a0' } } })).toBe(false);
        expect(records({ table: {} })).toBe(false);
        expect(records({ merge: [] })).toBe(false);
        expect(records({ merge: { m1: { rect: [0, 0, 1] } } })).toBe(false);
        expect(records({ merge: { '': { rect: [0, 0, 1, 1] } } })).toBe(false);
        expect(records({ image: { i1: { ...BOX } } })).toBe(false);
    });
});

// A seeded random number generator, so a failing case can be run again.
function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

const ODD: unknown[] = [
    null,
    undefined,
    true,
    0,
    -0,
    -1,
    1.5,
    Number.NaN,
    Number('1e400'),
    -Number('1e400'),
    2 ** 53,
    10n,
    '',
    '0',
    '=',
    '#N/A',
    '__proto__',
    'constructor',
    'x'.repeat(300),
    [],
    {},
    holed(1),
    Object.create(null),
    JSON.parse('{"__proto__":{"kind":"input"}}'),
];

function randomJson(next: () => number, depth: number): unknown {
    const pick = Math.floor(next() * (depth > 3 ? 1 : 3));
    if (pick === 0) return ODD[Math.floor(next() * ODD.length)];
    const length = Math.floor(next() * 5);
    if (pick === 1) return Array.from({ length }, () => randomJson(next, depth + 1));
    const keys = ['kind', 'sheet', 'cells', 'runs', 'v', 'f', 'g', 'ops', 'set', 'id', 'type', 'add', 'x'];
    return Object.fromEntries(
        Array.from({ length }, () => [keys[Math.floor(next() * keys.length)], randomJson(next, depth + 1)]),
    );
}

type Node = Record<string, unknown> | unknown[];

// Every object and array inside a value, so a mutation can pick one at random.
function nodesOf(value: unknown, into: Node[] = []): Node[] {
    if (Array.isArray(value) || isRecord(value)) into.push(value);
    if (Array.isArray(value)) for (const item of value) nodesOf(item, into);
    else if (isRecord(value)) for (const item of Object.values(value)) nodesOf(item, into);
    return into;
}

const VALID_OPS: Op[] = EXAMPLES.flatMap((batch) => batch.ops);

describe('never throws', () => {
    test('on odd values anywhere', () => {
        for (const value of ODD) {
            expect(() => readBatch(value)).not.toThrow();
            expect(() => readBatch({ g: 0, ...CLOCK, ops: [value] })).not.toThrow();
            expect(() => readBatch({ g: value, ...CLOCK, ops: [] })).not.toThrow();
            expect(() => readBatch(batchOf(cell(value)))).not.toThrow();
            expect(() => readBatch(batchOf(added({ cells: [[0, 0, value]] })))).not.toThrow();
            expect(() => isSheetContent(value)).not.toThrow();
        }
    });

    test('on deep nesting and huge arrays', () => {
        let deep: unknown = 1;
        for (let depth = 0; depth < 200_000; depth += 1) deep = [deep];
        let object: unknown = 1;
        for (let depth = 0; depth < 200_000; depth += 1) object = { v: object };
        expect(readBatch({ g: 0, ...CLOCK, ops: [deep] })).toBeNull();
        expect(readBatch(batchOf(cell(object)))).toBeNull();
        expect(readBatch(batchOf(input({ cells: [[0, 0, { s: deep }]] })))).toBeNull();
        expect(readBatch({ g: 0, ...CLOCK, ops: new Array(1_000_000).fill(7) })).toBeNull();
        expect(readBatch(batchOf(input({ cells: new Array(1_000_000).fill([0, 0, null]) })))).toBeNull();
    });

    test('on thousands of random JSON values', () => {
        const next = random(1);
        for (let round = 0; round < 5_000; round += 1) {
            const value = randomJson(next, 0);
            expect(() => readBatch(value)).not.toThrow();
            expect(() => readBatch({ g: 0, ...CLOCK, ops: [value] })).not.toThrow();
        }
    });

    test('on valid ops with one random mutation, which is refused or reads back the same', () => {
        const next = random(2);
        let refused = 0;
        for (let round = 0; round < 20_000; round += 1) {
            const op: unknown = structuredClone(VALID_OPS[Math.floor(next() * VALID_OPS.length)]);
            const nodes = nodesOf(op);
            const node = nodes[Math.floor(next() * nodes.length)];
            const keys = Array.isArray(node) ? node.map((_, index) => index) : Object.keys(node);
            const key = keys[Math.floor(next() * keys.length)];
            const mutation = Math.floor(next() * 4);
            const write = (value: unknown) => {
                if (Array.isArray(node)) node[Number(key ?? 0)] = value;
                else node[String(key ?? 'x')] = value;
            };
            if (mutation === 0 && !Array.isArray(node)) node['zz'] = 1;
            else if (mutation === 1) write(randomJson(next, 2));
            else if (mutation === 2) write(Number.NaN);
            else if (Array.isArray(node)) node.splice(Number(key ?? 0), 1);
            else delete node[String(key)];
            let read: Batch | null = null;
            expect(() => {
                read = readBatch(batchOf(op));
            }).not.toThrow();
            // A key no type lists, or a number JSON cannot carry, is never valid.
            if ((mutation === 0 && !Array.isArray(node)) || mutation === 2) expect(read).toBeNull();
            if (read === null) {
                refused += 1;
                continue;
            }
            const json = JSON.stringify(read);
            expect(JSON.stringify(readBatch(JSON.parse(json)))).toBe(json);
        }
        expect(refused).toBeGreaterThan(5_000);
    });
});
