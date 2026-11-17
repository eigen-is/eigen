import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import {
    BAND_WEIGHT,
    EXTRA_WEIGHT,
    MAX_RECORDS_PER_TYPE,
    MAX_SHEETS,
    MAX_STYLE_RUNS,
} from '@workspace/lib/sheets/limits';
import type {
    Batch,
    CellContent,
    FormatOp,
    InputOp,
    MoveOp,
    Op,
    Placed,
    RecordOp,
    Rect,
    SheetContent,
    SheetOp,
} from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import { covers } from '@workspace/lib/sheets/rect';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomAnyOp, randomBookContent, randomRowReaderOp, randomRowsOutOp } from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes, decoded } from './bytes';
import type { Model, ModelSheet } from './model';
import { expectReads, modelAfter, modelOf } from './model';
import { formulaRule } from './records-fixtures';

const LAST_ROW = GRID_ROWS - 1;
const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
// A sheet id as long as an id may be, so a formula bound to it grows.
const B = 'b'.repeat(60);
const PARTS = newChartSpecParts(sampleChartSpec('column'));

// A part of a chart's spec 40,000 bytes longer and the same JSON: two such parts take a chart past its size bound.
function padded(part: string): string {
    return `${part.slice(0, -1)}${' '.repeat(40_000)}${part.slice(-1)}`;
}

function chartChange(set: Partial<typeof PARTS>): RecordOp {
    return { kind: 'record', sheet: 'a', type: 'chart', id: 'g', set };
}

// A batch as a host lands it: the ops, then the clock of the batch, which a refused batch never reaches.
function land(book: Workbook, batch: Batch): Op[] {
    const inverse = applyOps(book, batch.ops);
    book.setClock(batch.now, batch.seed);
    return inverse;
}

function refusalOf(run: () => unknown): RefusalKey | undefined {
    try {
        run();
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
    return undefined;
}

function batch(...ops: Op[]): Batch {
    return { g: 1, now: 46_000.25, seed: 99, ops };
}

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// Two sheets, the second hidden, with a merge, a filter with a column, a comment, a chart one padded part short of its
// size bound, and formulas that read the clock, draw, read the other sheet and wait for a sheet named N, the last so
// long that the id of the second sheet does not fit it.
function twoSheets(): Book {
    const long = `="${'a'.repeat(131_010)}"&'N'!R1C1`;
    const a = sheetOf('a', {
        cells: [
            [0, 0, { v: 2 }],
            [1, 0, { f: '=NOW()' }],
            [2, 0, { f: '=RAND()' }],
            [3, 0, { f: `=[${B}]!R1C1*2` }],
            [4, 0, { f: long }],
        ],
        looks: [{ bl: 1 }],
        bands: [0, 1, 2, 1],
        rows: [[[1, 2], { size: 30 }]],
        records: {
            merge: { m: { rect: [5, 5, 6, 6] } },
            filter: { f: { rect: [8, 0, 20, 4] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [[9, 10]] } },
            comment: { c: { row: 3, column: 1 } },
            chart: {
                g: { index: 'a0', x: 0, y: 0, width: 1, height: 1, ...PARTS, specChart: padded(PARTS.specChart) },
            },
        },
    });
    const b = sheetOf(B, { fields: { name: 'Second', order: 'a1', hide: 1 }, cells: [[0, 0, { v: 21 }]] });
    return { g: 3, now: 45_000.5, seed: 7, computed: false, sheets: [a, b] };
}

// Ops that land on `twoSheets`, each of which changes its bytes, and the later ones what the earlier ones wrote.
const LANDING: readonly Op[] = [
    { kind: 'record', sheet: B, type: 'sheet', id: B, set: { name: 'Renamed', order: 'Zz' } },
    { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 5 } },
    { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9 } },
    { kind: 'record', sheet: 'a', type: 'filter', id: 'f2', set: { rect: [0, 0, 3, 3] }, whole: 1 },
    {
        kind: 'record',
        sheet: 'a',
        type: 'filterColumn',
        id: 'k2',
        set: { filter: 'f2', column: 0, rows: [] },
        whole: 1,
    },
    {
        kind: 'input',
        sheet: 'a',
        runs: [[[0, 1, 9, 2], { f: "='Renamed'!R1C1+1" }]],
        cells: [
            [0, 0, { v: 'x', link: { type: 'webpage', address: 'https://eigen.is' } }],
            [3, 0, null],
        ],
    },
    { kind: 'input', sheet: 'a', runs: [[[2, 2, 3, 3], null]], cells: [[1, 0, { s: [{ v: 'rich', bl: 1 }] }]] },
    // It restyles the rich cell the op before wrote, and links cells that hold a link, a formula and nothing.
    { kind: 'format', sheet: 'a', ranges: [[0, 0, 3, 1]], set: { it: 1, link: LINK }, clear: ['bl'] },
    { kind: 'format', sheet: 'a', lines: 'columns', spans: [[0, 1]], set: { size: 80 } },
];
const TRAILING: RecordOp = { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { color: '#ff0000' } };
// Four cells on the grid's last row hold more slots than the limit, as each column then holds every row.
const PAST_SLOTS = [1, 2, 3, 4].map((column) => [LAST_ROW, column, { v: 1 }] as const);
// Four bands of runs, no two neighbours alike, weigh past the format limit.
const PAST_FORMATS = Array.from({ length: 4 }, (_, band) => [
    band,
    MAX_STYLE_RUNS / 4,
    ...Array.from({ length: MAX_STYLE_RUNS / 4 }, (_, row) => [row, 1 + ((row + band) % 2)]).flat(),
]).flat();
// One comment more on a sheet than the limit on records of one type.
const PAST_RECORDS = Object.fromEntries(
    Array.from({ length: MAX_RECORDS_PER_TYPE + 1 }, (_, at) => [`c${at}`, { row: at, column: 0 }]),
);
const addOf = (id: string, part: Partial<SheetContent> = {}, name = id): SheetOp => ({
    kind: 'sheet',
    add: sheetOf(id, { fields: { name, order: 'a2' }, ...part }),
});
// `twoSheets` with a cell of sheet a, a record of sheet a or a record of the second sheet more.
function twoSheetsWith(
    cell?: Placed<CellContent>,
    onA: SheetContent['records'] = {},
    onB: SheetContent['records'] = {},
): Book {
    const book = twoSheets();
    const [a, b] = book.sheets;
    const cells = cell ? [...a.cells, cell].sort((x, y) => x[1] - y[1] || x[0] - y[0]) : a.cells;
    const sheets = [
        { ...a, cells, records: { ...a.records, ...onA } },
        { ...b, records: { ...b.records, ...onB } },
    ];
    return { ...book, sheets };
}
// A formula a cell stores as long as it may be, but for the id of the second sheet, which a move of R1C1 there adds.
const NEAR_BOUND = `="${'a'.repeat(131_050)}"&R1C1`;
const moveOf = (from: Rect, toRow: number, toColumn: number, toSheet = 'a'): MoveOp => ({
    kind: 'move',
    sheet: 'a',
    from,
    toSheet,
    toRow,
    toColumn,
});
// The refused op, and the book it is refused on when that is not `twoSheets`.
const REFUSED: readonly [RefusalKey, Op, Book?][] = [
    ['merge-overlap', { kind: 'record', sheet: 'a', type: 'merge', id: 'm2', set: { rect: [6, 6, 7, 7] }, whole: 1 }],
    ['last-sheet', { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { hide: 1 } }],
    ['last-sheet', { kind: 'sheet', delete: 'a' }],
    ['key-too-long', { kind: 'record', sheet: B, type: 'sheet', id: B, set: { name: 'N' } }],
    ['key-too-long', chartChange({ specTitle: padded(PARTS.specTitle) })],
    // The engine refuses the add, as the name binds a formula of sheet a past the stored bound.
    ['key-too-long', addOf('c'.repeat(60), { looks: [{ fs: 99 }], bands: [0, 1, 0, 1] }, 'N')],
    ['too-many-cells', addOf('c', { cells: [...PAST_SLOTS] })],
    ['too-many-formats', addOf('c', { looks: [{ bl: 1 }, { it: 1 }], bands: PAST_FORMATS })],
    ['too-many-records', addOf('c', { records: { comment: PAST_RECORDS } })],
    [
        'too-many-sheets',
        addOf('c'),
        (() => {
            const book = twoSheets();
            const more = Array.from({ length: MAX_SHEETS - 2 }, (_, at) =>
                sheetOf(`x${at}`, { fields: { name: `x${at}`, order: 'b' } }),
            );
            return { ...book, sheets: [...book.sheets, ...more] };
        })(),
    ],
    ['merge-cut', moveOf([5, 5, 5, 6], 30, 30)],
    ['merge-cut', moveOf([30, 30, 30, 30], 6, 6)],
    ['id-in-use', { kind: 'record', sheet: B, type: 'comment', id: 'c', set: { row: 1, column: 1 }, whole: 1 }],
    ['id-in-use', addOf('c', { records: { comment: { c: { row: 1, column: 1 } } } })],
    ['key-too-long', moveOf([0, 0, 0, 0], 5, 5, B), twoSheetsWith([7, 0, { f: NEAR_BOUND }])],
    [
        'key-too-long',
        moveOf([0, 0, 0, 0], 5, 5, B),
        twoSheetsWith(undefined, { conditionalFormat: { r: formulaRule([[40, 0, 40, 0]], NEAR_BOUND) } }),
    ],
];

describe('engine/book/apply-ops — LAW 1: a refused batch leaves the bytes as they were', () => {
    for (const [key, refused, on] of REFUSED) {
        for (let k = 0; k <= LANDING.length; k += 1) {
            test(`${key} by a ${refused.kind} op at op ${k}, after ${k} ops landed`, () => {
                const content = on ?? twoSheets();
                const book = new Workbook(content);
                const before = bytes(book);
                expect(refusalOf(() => land(book, batch(...LANDING.slice(0, k), refused, TRAILING)))).toBe(key);
                expect(bytes(book)).toBe(before);
                expectReads(book, modelOf(content));
                // The same ops without the refused one do land, so the refusal took something back.
                const other = new Workbook(content);
                land(other, batch(...LANDING.slice(0, k), TRAILING));
                expect(bytes(other)).not.toBe(before);
            });
        }
    }

    // The store refuses the chart for what an earlier op of the batch wrote to it, so the frame takes that op back.
    test('key-too-long by a chart change that an earlier op of the batch took near the bound', () => {
        const [a, b] = twoSheets().sheets;
        const chart = { index: 'a0', x: 0, y: 0, width: 1, height: 1, ...PARTS };
        const content: Book = {
            g: 3,
            now: 45_000.5,
            seed: 7,
            computed: false,
            sheets: [{ ...a, records: { chart: { g: chart } } }, b],
        };
        const ops = [
            chartChange({ specLegend: padded(PARTS.specLegend) }),
            chartChange({ specTitle: padded(PARTS.specTitle) }),
        ];
        const book = new Workbook(content);
        const before = bytes(book);
        expect(refusalOf(() => land(book, batch(...ops)))).toBe('key-too-long');
        expect(bytes(book)).toBe(before);
        expectReads(book, modelOf(content));
        // Each op lands alone.
        for (const op of ops) {
            const other = new Workbook(content);
            land(other, batch(op));
            expect(bytes(other)).not.toBe(before);
        }
    });

    const PAST_LIMIT: InputOp = { kind: 'input', sheet: 'a', cells: [...PAST_SLOTS] };
    const BACK: InputOp = { kind: 'input', sheet: 'a', runs: [[[LAST_ROW, 1, LAST_ROW, 4], null]] };

    for (let k = 0; k <= LANDING.length; k += 1) {
        test(`too-many-cells at the weigh, after ${k} ops landed`, () => {
            const content = twoSheets();
            const book = new Workbook(content);
            const before = bytes(book);
            expect(refusalOf(() => land(book, batch(...LANDING.slice(0, k), PAST_LIMIT)))).toBe('too-many-cells');
            expect(bytes(book)).toBe(before);
            expectReads(book, modelOf(content));
        });
    }

    test('the limits are weighed after the last op only: a batch past them midway and back within them lands', () => {
        const book = new Workbook(twoSheets());
        const before = bytes(book);
        expect(refusalOf(() => land(book, batch(LANDING[1], PAST_LIMIT, BACK)))).toBeUndefined();
        expect(bytes(book)).not.toBe(before);
        expect(book.engine.columnLength('a', 1)).toBe(0);
    });

    test('a sheet added past the limits and deleted in the same batch lands', () => {
        const book = new Workbook(twoSheets());
        const before = bytes(book);
        const ops: Op[] = [addOf('c', { cells: [...PAST_SLOTS] }), LANDING[1], { kind: 'sheet', delete: 'c' }];
        expect(refusalOf(() => land(book, batch(...ops)))).toBeUndefined();
        expect(bytes(book)).not.toBe(before);
        expect(book.sheets.has('c')).toBe(false);
    });

    test('too-many-formats at the weigh', () => {
        // Four bands of runs, no two neighbours alike, weigh the limit to the run with the other sheet's one band.
        const runs = (MAX_STYLE_RUNS - 5 * 32) / 4;
        const bands = Array.from({ length: 4 }, (_, band) => [
            band,
            runs,
            ...Array.from({ length: runs }, (_, row) => [row, 1 + ((row + band) % 2)]).flat(),
        ]).flat();
        const content = twoSheets();
        content.sheets[0] = { ...content.sheets[0], looks: [{ bl: 1 }, { it: 1 }], bands };
        const book = new Workbook(content);
        const state = () => JSON.stringify(book.content().sheets.map(({ fields, records }) => [fields, records]));
        // A book at the limit takes a batch, and one band more takes none.
        expect(refusalOf(() => land(book, batch(LANDING[0])))).toBeUndefined();
        book.sheets.get('a')?.bands.write([[0, 9, 0, 9]], () => 0);
        const before = state();
        expect(refusalOf(() => land(book, batch(...LANDING.slice(1))))).toBe('too-many-formats');
        expect(state()).toBe(before);
    });

    test('a refused batch leaves the clock, which a landed one moves', () => {
        const book = new Workbook(twoSheets());
        bytes(book);
        const drawn = book.engine.valueOf('a', 2, 0);
        expect(refusalOf(() => land(book, batch(LANDING[1], REFUSED[0][1])))).toBe('merge-overlap');
        bytes(book);
        expect(book.content()).toMatchObject({ now: 45_000.5, seed: 7 });
        expect(book.engine.valueOf('a', 1, 0)).toBe(45_000.5);
        expect(book.engine.valueOf('a', 2, 0)).toBe(drawn);

        land(book, batch(LANDING[1]));
        bytes(book);
        expect(book.content()).toMatchObject({ now: 46_000.25, seed: 99 });
        expect(book.engine.valueOf('a', 1, 0)).toBe(46_000.25);
        expect(book.engine.valueOf('a', 2, 0)).not.toBe(drawn);
    });

    test('a clock the engine does not take leaves the book’s clock as it was', () => {
        const book = new Workbook(twoSheets());
        expect(() => book.setClock(Number.NaN, 1)).toThrow(RangeError);
        expect(() => book.setClock(1, 0.5)).toThrow(RangeError);
        expect(book.content()).toMatchObject({ now: 45_000.5, seed: 7 });
    });
});

describe('engine/book/apply-ops — LAW 1: a format past the format limit is refused at the weigh', () => {
    // Filler sheets of one band per column, no two neighbours alike, weigh the book to MARGIN short of the limit, or up
    // to a band's weight less: well past what the landing ops add.
    const MARGIN = 2_000;
    const filler = (id: string, columns: number) =>
        sheetOf(id, {
            fields: { name: id, order: 'b' },
            looks: [{ bl: 1 }, { it: 1 }],
            bands: Array.from({ length: columns }, (_, column) => [column, 1, 0, 1 + (column % 2)]).flat(),
        });
    const formatsOf = (book: Workbook) => {
        const { runs, bands, extras } = book.weight();
        return runs + bands * BAND_WEIGHT + extras * EXTRA_WEIGHT;
    };
    const near = (() => {
        const content = twoSheets();
        const full = Array.from({ length: 7 }, (_, at) => filler(`f${at}`, GRID_COLUMNS));
        const left = MAX_STYLE_RUNS - formatsOf(new Workbook({ ...content, sheets: [...content.sheets, ...full] }));
        // A filler band weighs its run and itself.
        const columns = Math.floor((left - MARGIN) / (1 + BAND_WEIGHT));
        return { ...content, sheets: [...content.sheets, ...full, filler('f7', columns)] };
    })();
    // Forty whole columns apart, each two bands more; a link on a hundred cells, each an entry with a link.
    const PAST: readonly [string, FormatOp][] = [
        [
            'runs and bands',
            {
                kind: 'format',
                sheet: 'a',
                ranges: Array.from({ length: 40 }, (_, at) => [0, 20 + 2 * at, LAST_ROW, 20 + 2 * at] as const),
                set: { bg: '#00ff00' },
            },
        ],
        ['a ranged link', { kind: 'format', sheet: 'a', ranges: [[0, 20, 99, 20]], set: { link: LINK } }],
    ];

    test('the book is a margin short of the limit, and the landing ops fit in it', () => {
        const book = new Workbook(near);
        const short = MAX_STYLE_RUNS - formatsOf(book);
        expect(short).toBeGreaterThanOrEqual(MARGIN);
        expect(short).toBeLessThan(MARGIN + 1 + BAND_WEIGHT);
        land(book, batch(...LANDING, TRAILING));
        expect(MAX_STYLE_RUNS - formatsOf(book)).toBeGreaterThan(MARGIN / 2);
    });

    for (const [reached, past] of PAST) {
        for (let k = 0; k <= LANDING.length; k += 1) {
            test(`by ${reached} at op ${k}, after ${k} ops landed and before the rest`, () => {
                const book = new Workbook(near);
                const before = bytes(book);
                const ops = [...LANDING.slice(0, k), past, ...LANDING.slice(k), TRAILING];
                expect(refusalOf(() => land(book, batch(...ops)))).toBe('too-many-formats');
                expect(bytes(book)).toBe(before);
            });
        }
    }
});

describe('engine/book/apply-ops — the inverse batch', () => {
    test('it holds the inverse of every op, the newest first, in one list', () => {
        const book = new Workbook(twoSheets());
        expect(applyOps(book, LANDING.slice(1, 4))).toEqual([
            { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [8, 0, 20, 4] }, whole: 1 },
            {
                kind: 'record',
                sheet: 'a',
                type: 'filterColumn',
                id: 'k',
                set: { filter: 'f', column: 1, rows: [[9, 10]] },
                whole: 1,
            },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 5 } },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 3 } },
        ]);
    });

    test('a batch of no op and a batch of skipped ops have no inverse', () => {
        const book = new Workbook(twoSheets());
        const before = bytes(book);
        expect(applyOps(book, [])).toEqual([]);
        expect(applyOps(book, [{ kind: 'record', sheet: 'gone', type: 'comment', id: 'c' }])).toEqual([]);
        expect(applyOps(book, [{ kind: 'record', sheet: 'a', type: 'comment', id: 'gone', set: { row: 1 } }])).toEqual(
            [],
        );
        expect(bytes(book)).toBe(before);
    });

    test('LAW 2 on the ops that land: the inverse restores the bytes, and its inverse the bytes after', () => {
        const content = twoSheets();
        const book = new Workbook(content);
        const before = bytes(book);
        const inverse = land(book, batch(...LANDING, TRAILING));
        const after = bytes(book);
        expect(after).not.toBe(before);
        const again = applyOps(book, inverse);
        book.setClock(content.now, content.seed);
        expect(bytes(book)).toBe(before);
        land(book, batch(...again));
        expect(bytes(book)).toBe(after);
    });
});

describe('engine/book/apply-ops — the look sweep', () => {
    const wearUnused = (book: Workbook) => {
        for (let i = 0; i < 100; i += 1) book.looks.intern({ fs: 100 + i });
    };

    test('a batch that lands ends with a sweep', () => {
        const book = new Workbook(twoSheets());
        wearUnused(book);
        applyOps(book, [LANDING[1]]);
        expect(book.looks.size).toBe(2);
    });

    test('a batch that is refused ends with a sweep', () => {
        const book = new Workbook(twoSheets());
        wearUnused(book);
        expect(refusalOf(() => applyOps(book, [LANDING[1], REFUSED[0][1]]))).toBe('merge-overlap');
        expect(book.looks.size).toBe(2);
    });
});

// The mix of the general law with, two ops in five, a formula that leaves rows out or a change of the rows a sheet
// hides or filters.
function randomRowsOrAnyOp(random: () => number, model: Model): Op {
    const draw = random();
    if (draw < 0.15) return randomRowReaderOp(random, model);
    return draw < 0.4 ? randomRowsOutOp(random, model) : randomAnyOp(random, model);
}

// Whether a formula of the book leaves rows out.
function readsRows(model: Model): boolean {
    return [...model.sheets.values()].some(({ cells }) =>
        [...cells.values()].some(({ f }) => /SUBTOTAL|AGGREGATE/.test(f ?? '')),
    );
}

// The last row a sheet hides or filters, or -1.
function lastRowOut({ rows, records }: ModelSheet): number {
    const hidden = [...rows].filter(([, attrs]) => attrs.hidden).map(([row]) => row);
    const filtered = [...records.filterColumn.values()].flatMap((column) => column.rows.map(([, last]) => last));
    return Math.max(-1, ...hidden, ...filtered);
}

// What an op that lands does to the rows the sheets of the model hide or filter.
type RowStep =
    | 'hide'
    | 'hideInFilter'
    | 'hideOutFilter'
    | 'show'
    | 'filterOn'
    | 'filterOff'
    | 'filterRows'
    | 'insertAround'
    | 'deleteAround'
    | 'move'
    | 'sheetDelete'
    | 'sheetAdd';

function rowStepsOf(model: Model, op: Op): RowStep[] {
    if (op.kind === 'sheet') return ['add' in op ? 'sheetAdd' : 'sheetDelete'];
    const sheet = model.sheets.get(op.sheet);
    if (!sheet) return [];
    const last = lastRowOut(sheet);
    if (op.kind === 'format' && 'lines' in op && op.lines === 'rows') {
        const shows = op.clear?.includes('hidden') && last >= 0;
        if (!op.set?.hidden) return shows ? ['show'] : [];
        // A hide on a sheet whose filter leaves a row out, by whether its rows lie inside the filter's range.
        const [filter] = sheet.records.filter;
        const columns = [...sheet.records.filterColumn.values()];
        if (!filter || !columns.some((column) => column.filter === filter[0] && column.rows.length > 0))
            return ['hide'];
        const [top, , bottom] = filter[1].rect;
        const inside = op.spans.every(([first, end]) => first >= top && end <= bottom);
        return ['hide', inside ? 'hideInFilter' : 'hideOutFilter'];
    }
    if (op.kind === 'record' && op.type === 'filter') {
        return op.set ? ['filterOn'] : sheet.records.filterColumn.size > 0 ? ['filterOff'] : [];
    }
    if (op.kind === 'record' && op.type === 'filterColumn') return ['filterRows'];
    if (op.kind === 'lines' && op.rows && op.index <= last) return [op.insert ? 'insertAround' : 'deleteAround'];
    const landing = op.kind === 'move' ? model.sheets.get(op.toSheet) : undefined;
    return landing && Math.max(last, lastRowOut(landing)) >= 0 ? ['move'] : [];
}

// Random books under random batches drawn by `make`: LAW 1 on each refused batch, LAW 2 and the model's reads on each
// that lands, its inverse and the inverse of that. With `rows` the bytes after every batch that lands are also those
// of a book loaded fresh from its content, which computes every formula with the rows the content hides and filters.
function lawRun(seeds: number, make: (random: () => number, model: Model) => Op, rows: boolean) {
    const refusedAt = new Map<string, number>();
    const kinds = new Map<string, number>();
    let landed = 0;
    let undone = 0;
    // The sheet ops that landed, by what their inverse is: an add lands as its delete, a delete as its add.
    const sheets = { add: 0, delete: 0 };
    // The format ops in the inverses: over cells, over lines, and of a link.
    const formats = { cells: 0, lines: 0, links: 0 };
    // The loads trusted whole, and those that compute every formula.
    const loads = { computed: 0, computing: 0 };
    // The inputs that landed with a listed cell inside one of their runs.
    let cellInRun = 0;
    // What landed, and what was refused after an op landed, in a book that held a formula that leaves rows out:
    // by what the op does to the rows its sheet hides or filters.
    const rowSteps = {
        hide: 0,
        hideInFilter: 0,
        hideOutFilter: 0,
        show: 0,
        filterOn: 0,
        filterOff: 0,
        filterRows: 0,
        insertAround: 0,
        deleteAround: 0,
        move: 0,
        sheetDelete: 0,
        sheetAdd: 0,
        refused: 0,
    };
    const fresh = (text: string) => bytes(new Workbook({ ...decoded(text), computed: false }));
    for (let seed = 1; seed <= seeds; seed += 1) {
        const random = randomOf(seed);
        const content = randomBookContent(random);
        loads[content.computed ? 'computed' : 'computing'] += 1;
        const book = new Workbook(content);
        let model: Model = modelOf(content);
        if (rows) expect(fresh(bytes(book))).toBe(bytes(book));
        for (let round = 0; round < 8; round += 1) {
            const drawn = batchOf(random, model, make, 6);
            const before = bytes(book);
            const rowsRead = readsRows(model);
            const clock = model;
            const next = modelAfter(model, drawn);
            // Now and then a batch that lands ends past the limit on cells, which only the weigh after it refuses.
            const held = typeof next === 'string' ? [] : [...next.sheets.keys()];
            const past = held.length > 0 && random() < 0.03;
            const sheet = held[Math.floor(random() * held.length)];
            const ops: Batch = past
                ? { ...drawn, ops: [...drawn.ops, { kind: 'input', sheet, cells: [...PAST_SLOTS] }] }
                : drawn;
            const expected = past ? 'too-many-cells' : next;
            if (typeof expected === 'string') {
                // The first op the model refuses, with every op before it landed.
                const at = past
                    ? drawn.ops.length
                    : ops.ops.findIndex(
                          (_, k) => typeof modelAfter(model, { ...ops, ops: ops.ops.slice(0, k + 1) }) === 'string',
                      );
                refusedAt.set(`${expected} ${at}`, (refusedAt.get(`${expected} ${at}`) ?? 0) + 1);
                expect(refusalOf(() => land(book, ops))).toBe(expected);
                expect(bytes(book)).toBe(before);
                expectReads(book, model);
                if (rowsRead && at > 0) rowSteps.refused += 1;
                continue;
            }
            const inverse = land(book, ops);
            landed += 1;
            for (const op of ops.ops) {
                kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1);
                if (op.kind !== 'input') continue;
                if (op.cells?.some(([row, column]) => op.runs?.some(([rect]) => covers(rect, row, column))))
                    cellInRun += 1;
            }
            if (rowsRead) for (const op of ops.ops) for (const step of rowStepsOf(model, op)) rowSteps[step] += 1;
            expectReads(book, expected);
            model = expected;
            const after = bytes(book);
            if (rows) expect([seed, round, fresh(after)]).toEqual([seed, round, after]);
            const text = JSON.stringify({ ...ops, ops: inverse });
            expect(readBatch(text)).toEqual(JSON.parse(text));
            const again = applyOps(book, inverse);
            book.setClock(clock.now, clock.seed);
            expect(bytes(book)).toBe(before);
            expectReads(book, clock);
            land(book, { ...ops, ops: again });
            expect(bytes(book)).toBe(after);
            undone += 1;
            for (const op of inverse) {
                if (op.kind === 'sheet') sheets['add' in op ? 'delete' : 'add'] += 1;
                if (op.kind !== 'format') continue;
                formats['lines' in op ? 'lines' : 'cells'] += 1;
                if ('ranges' in op && (op.set?.link || op.clear?.includes('link'))) formats.links += 1;
            }
        }
    }
    return { refusedAt, kinds, landed, undone, sheets, formats, loads, cellInRun, rowSteps };
}

describe('engine/book/apply-ops — the laws over random books and random batches of every kind built', () => {
    test('a rename of a sheet a formula names but does not read keeps LAW 1, LAW 2 and LAW 7', () => {
        const content: Book = {
            g: 1,
            now: 1,
            seed: 1,
            computed: false,
            sheets: [
                sheetOf('a', {
                    cells: [[0, 0, { f: "='N'!R1C1+1" }]],
                    records: { merge: { m: { rect: [5, 5, 6, 6] } } },
                }),
                sheetOf('b', { fields: { name: 'N', order: 'a1' }, cells: [[0, 0, { v: 5 }]] }),
            ],
        };
        const rename: RecordOp = { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { name: 'Y' } };
        const before = bytes(new Workbook(content));

        const refused = new Workbook(content);
        expect(refusalOf(() => applyOps(refused, [rename, REFUSED[0][1]]))).toBe('merge-overlap');
        expect(bytes(refused)).toBe(before);

        const undone = new Workbook(content);
        applyOps(undone, applyOps(undone, [rename]));
        expect(bytes(undone)).toBe(before);

        const replayed = new Workbook(content);
        const takenBack = new Workbook(content);
        applyOps(takenBack, applyOps(takenBack, [rename]));
        for (const reader of [replayed, takenBack]) land(reader, batch(TRAILING));
        expect(bytes(takenBack)).toBe(bytes(replayed));
    });

    test('LAW 1, LAW 2, law 6 and law 8', () => {
        const { refusedAt, kinds, landed, undone, sheets, formats, loads, cellInRun } = lawRun(600, randomAnyOp, false);
        expect(loads.computed).toBeGreaterThan(250);
        expect(loads.computing).toBeGreaterThan(250);
        expect(landed).toBeGreaterThan(3500);
        expect(undone).toBe(landed);
        for (const kind of ['input', 'format', 'record', 'lines', 'move', 'sheet']) {
            expect(kinds.get(kind) ?? 0).toBeGreaterThan(1000);
        }
        expect(sheets.add).toBeGreaterThan(700);
        expect(sheets.delete).toBeGreaterThan(350);
        expect(formats.cells).toBeGreaterThan(2000);
        expect(formats.lines).toBeGreaterThan(500);
        expect(formats.links).toBeGreaterThan(100);
        expect(cellInRun).toBeGreaterThan(100);
        // A refusal at every place of a batch: no random op comes near the stored bound, so `key-too-long` is pinned
        // case by case above, as are the limits a random book stays far from.
        for (const key of ['grid-end', 'merge-overlap', 'merge-cut', 'id-in-use', 'last-sheet']) {
            for (let k = 0; k < 4; k += 1) expect(refusedAt.get(`${key} ${k}`) ?? 0).toBeGreaterThan(0);
        }
        for (let k = 0; k < 4; k += 1) expect(refusedAt.get(`merge-overlap ${k}`) ?? 0).toBeGreaterThan(30);
        for (let k = 1; k < 5; k += 1) expect(refusedAt.get(`too-many-cells ${k}`) ?? 0).toBeGreaterThan(5);
    }, 120_000);

    // The same laws under a mix with formulas that leave rows out and changes of the rows a sheet hides or filters,
    // and the law of those rows: after every batch the bytes are those of a fresh load.
    test('the rows a sheet hides and filters: an edited book holds the bytes of one loaded fresh from its content', () => {
        const { kinds, landed, undone, loads, rowSteps } = lawRun(300, randomRowsOrAnyOp, true);
        if (process.env['LAW_COUNTS'] !== undefined) console.log(JSON.stringify({ landed, loads, rowSteps }));
        expect(loads.computed).toBeGreaterThan(100);
        expect(loads.computing).toBeGreaterThan(100);
        expect(landed).toBeGreaterThan(1500);
        expect(undone).toBe(landed);
        for (const kind of ['input', 'format', 'record', 'lines', 'move', 'sheet']) {
            expect(kinds.get(kind) ?? 0).toBeGreaterThan(300);
        }
        const { hideInFilter, hideOutFilter, ...steps } = rowSteps;
        for (const count of Object.values(steps)) expect(count).toBeGreaterThan(50);
        // A row hidden while the filter leaves a row out, inside its range and outside: both are filtered then.
        expect(Math.min(hideInFilter, hideOutFilter)).toBeGreaterThan(25);
    }, 120_000);
});
