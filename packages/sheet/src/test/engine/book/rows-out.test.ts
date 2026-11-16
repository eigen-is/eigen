import { describe, expect, test } from 'bun:test';
import type { Literal } from '@workspace/formula';
import { REF } from '@workspace/formula';
import type { CellRecord, Op, Placed, RecordOp, SheetContent } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { bytes, decoded } from './bytes';

// The rows a sheet hides and filters reach the engine by one function, at a load, with an added sheet and after
// every batch that can have changed them: SUBTOTAL and AGGREGATE then read as a book loaded fresh from the same
// content does. Column A of sheet `a` holds 1, 2, 4, 8, 16 and 32, and column C four totals of it.

const TOTALS = ['=SUBTOTAL(109,R1C1:R6C1)', '=SUBTOTAL(9,R1C1:R6C1)', '=AGGREGATE(9,5,R1C1:R6C1)', '=SUM(R1C1:R6C1)'];
const CELLS: Placed<CellRecord>[] = [
    ...[1, 2, 4, 8, 16, 32].map((v, row): Placed<CellRecord> => [row, 0, { v }]),
    ...TOTALS.map((f, row): Placed<CellRecord> => [row, 2, { f }]),
];
const FILTER = { f: { rect: [0, 0, 20, 1] as const } };

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: CELLS, looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 1, seed: 1, computed: false, sheets };
}

// The four totals, once every formula is computed, and the same from a book loaded fresh from the content.
function totals(book: Workbook, sheet = 'a', column = 2): (Literal | null)[] {
    const text = bytes(book);
    expect(bytes(new Workbook({ ...decoded(text), computed: false }))).toBe(text);
    return TOTALS.map((_, row) => book.engine.valueOf(sheet, row, column));
}

function hide(first: number, last: number, sheet = 'a'): Op {
    return { kind: 'format', sheet, lines: 'rows', spans: [[first, last]], set: { hidden: 1 } };
}

function show(first: number, last: number): Op {
    return { kind: 'format', sheet: 'a', lines: 'rows', spans: [[first, last]], clear: ['hidden'] };
}

function filterColumn(id: string, rows: [number, number][], column = 0): RecordOp {
    return { kind: 'record', sheet: 'a', type: 'filterColumn', id, set: { filter: 'f', column, rows }, whole: 1 };
}

const HIDDEN_AND_FILTERED: Partial<SheetContent> = {
    rows: [[[1, 1], { hidden: 1 }]],
    records: { filter: FILTER, filterColumn: { k: { filter: 'f', column: 0, rows: [[3, 3]] } } },
};

describe('engine/book — a load says the rows a sheet hides and filters with its cells', () => {
    test('a load that computes leaves out the hidden row for 109 and option 5, the filtered row for 9 too', () => {
        expect(totals(new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED))))).toEqual([53, 55, 53, 63]);
    });

    test('runs side by side that are hidden with other keys, and filter columns whose rows overlap, are one set', () => {
        const book = new Workbook(
            bookOf(
                sheetOf('a', {
                    rows: [
                        [[0, 0], { hidden: 1, size: 30 }],
                        [[1, 1], { hidden: 1 }],
                        [[2, 2], { size: 30 }],
                    ],
                    records: {
                        filter: FILTER,
                        filterColumn: {
                            k: { filter: 'f', column: 1, rows: [[4, 5]] },
                            j: { filter: 'f', column: 0, rows: [[3, 4]] },
                        },
                    },
                }),
            ),
        );
        expect(totals(book)).toEqual([4, 7, 4, 63]);
        // The two hidden runs become one run: the same rows, so the engine is told nothing new.
        applyOps(book, [{ kind: 'format', sheet: 'a', lines: 'rows', spans: [[1, 1]], set: { size: 30 } }]);
        expect(book.sheets.get('a')?.rows.content()[0]).toEqual([[0, 1], { size: 30, hidden: 1 }]);
        expect(book.engine.settled()).toBe(true);
    });

    test('a computed load is settled and trusts its values: a book with hidden rows pays no pass at its open', () => {
        const cells = CELLS.map(
            ([row, column, cell]): Placed<CellRecord> => [row, column, cell.f ? { ...cell, v: 'held' } : cell],
        );
        const book = new Workbook({ ...bookOf(sheetOf('a', { ...HIDDEN_AND_FILTERED, cells })), computed: true });
        expect(book.engine.settled()).toBe(true);
        expect(book.engine.recalc(Number.MAX_SAFE_INTEGER).changed).toEqual([]);
        // A batch that types a cell, and one that changes a record but no row, leave the engine its rows.
        applyOps(book, [
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9, column: 9 }, whole: 1 },
        ]);
        expect([book.engine.settled(), book.content().computed]).toEqual([true, true]);
        applyOps(book, [{ kind: 'input', sheet: 'a', cells: [[9, 9, { v: 1 }]] }]);
        book.engine.recalc(Number.MAX_SAFE_INTEGER);
        expect(book.engine.valueOf('a', 0, 2)).toBe('held');
        // The rows the load brought are the engine's: a formula typed now reads them.
        applyOps(book, [{ kind: 'input', sheet: 'a', cells: [[0, 4, { f: TOTALS[0] }]] }]);
        book.engine.recalc(Number.MAX_SAFE_INTEGER);
        expect(book.engine.valueOf('a', 0, 4)).toBe(53);
    });

    test('a hidden column leaves every total as it was', () => {
        const book = new Workbook(bookOf(sheetOf('a', { columns: [[[0, 0], { hidden: 1 }]] })));
        expect(totals(book)).toEqual([63, 63, 63, 63]);
        applyOps(book, [{ kind: 'format', sheet: 'a', lines: 'columns', spans: [[0, 2]], set: { hidden: 1 } }]);
        expect(book.engine.settled()).toBe(true);
        expect(totals(book)).toEqual([63, 63, 63, 63]);
    });
});

describe('engine/book — after a batch the engine holds the rows the sheets hide and filter', () => {
    test('a row hidden, another hidden beside it, and shown again', () => {
        const book = new Workbook(bookOf(sheetOf('a')));
        expect(totals(book)).toEqual([63, 63, 63, 63]);
        applyOps(book, [hide(1, 1)]);
        expect(book.engine.settled()).toBe(false);
        expect(totals(book)).toEqual([61, 63, 61, 63]);
        applyOps(book, [hide(2, 3)]);
        expect(totals(book)).toEqual([49, 63, 49, 63]);
        applyOps(book, [show(0, 2)]);
        expect(totals(book)).toEqual([55, 63, 55, 63]);
    });

    test('a filter column made, its rows changed, a second one, one deleted, the filter deleted', () => {
        const book = new Workbook(bookOf(sheetOf('a', { records: { filter: FILTER } })));
        applyOps(book, [filterColumn('k', [[3, 3]])]);
        expect(totals(book)).toEqual([55, 55, 55, 63]);
        applyOps(book, [{ kind: 'record', sheet: 'a', type: 'filterColumn', id: 'k', set: { rows: [[0, 1]] } }]);
        expect(totals(book)).toEqual([60, 60, 60, 63]);
        applyOps(book, [filterColumn('j', [[1, 2]], 1)]);
        expect(totals(book)).toEqual([56, 56, 56, 63]);
        applyOps(book, [{ kind: 'record', sheet: 'a', type: 'filterColumn', id: 'k' }]);
        expect(totals(book)).toEqual([57, 57, 57, 63]);
        applyOps(book, [{ kind: 'record', sheet: 'a', type: 'filter', id: 'f' }]);
        expect(totals(book)).toEqual([63, 63, 63, 63]);
    });

    test('a new filter takes the place of the one before, with its columns', () => {
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED)));
        applyOps(book, [
            { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 1] }, whole: 1 },
        ]);
        expect(totals(book)).toEqual([61, 63, 61, 63]);
    });

    test('rows inserted above a hidden and a filtered row, and those rows deleted', () => {
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED)));
        applyOps(book, [{ kind: 'lines', sheet: 'a', rows: true, insert: true, index: 0, count: 2 }]);
        // The totals moved two rows down with the numbers they read.
        expect(book.engine.formulaOf('a', 2, 2)).toBe('=SUBTOTAL(109,R3C1:R8C1)');
        totals(book);
        expect([2, 3, 4, 5].map((row) => book.engine.valueOf('a', row, 2))).toEqual([53, 55, 53, 63]);
        // The hidden row goes, with the 2 and the second total on it.
        applyOps(book, [{ kind: 'lines', sheet: 'a', rows: true, insert: false, index: 3, count: 1 }]);
        totals(book);
        expect([2, 3, 4].map((row) => book.engine.valueOf('a', row, 2))).toEqual([53, 53, 61]);
    });

    test('a deleted column takes its filter column, and the rows it left out show', () => {
        const book = new Workbook(
            bookOf(
                sheetOf('a', {
                    records: { filter: FILTER, filterColumn: { k: { filter: 'f', column: 1, rows: [[3, 3]] } } },
                }),
            ),
        );
        expect(totals(book)).toEqual([55, 55, 55, 63]);
        applyOps(book, [{ kind: 'lines', sheet: 'a', rows: false, insert: false, index: 1, count: 1 }]);
        expect(totals(book, 'a', 1)).toEqual([63, 63, 63, 63]);
    });

    // The rows the batch leaves hidden are the rows it found hidden, and other cells sit on them.
    test('a batch that inserts a row above a hidden one, shows it and hides the row above', () => {
        const book = new Workbook(bookOf(sheetOf('a', { rows: [[[1, 1], { hidden: 1 }]] })));
        applyOps(book, [{ kind: 'input', sheet: 'a', cells: [[0, 4, { f: '=SUBTOTAL(109,C1:C1)' }]] }]);
        totals(book);
        expect(book.engine.valueOf('a', 0, 4)).toBe(61);
        applyOps(book, [
            { kind: 'lines', sheet: 'a', rows: true, insert: true, index: 1, count: 1 },
            show(2, 2),
            hide(1, 1),
        ]);
        expect(book.sheets.get('a')?.rows.content()).toEqual([[[1, 1], { hidden: 1 }]]);
        totals(book);
        expect(book.engine.valueOf('a', 0, 4)).toBe(63);
    });

    test('a block moved to rows that show, and back', () => {
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED)));
        expect(totals(book)).toEqual([53, 55, 53, 63]);
        const inverse = applyOps(book, [
            { kind: 'move', sheet: 'a', from: [0, 0, 5, 0], toSheet: 'a', toRow: 10, toColumn: 0 },
        ]);
        expect(totals(book)).toEqual([63, 63, 63, 63]);
        applyOps(book, inverse);
        expect(totals(book)).toEqual([53, 55, 53, 63]);
    });

    test('a sheet deleted and added back by the inverse, for a total on another sheet', () => {
        const reader = sheetOf('b', {
            fields: { name: 'b', order: 'a1' },
            cells: TOTALS.map((f, row): Placed<CellRecord> => [row, 2, { f: f.replace('R1C1', '[a]!R1C1') }]),
        });
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED), reader));
        expect(totals(book, 'b')).toEqual([53, 55, 53, 63]);
        const inverse = applyOps(book, [{ kind: 'sheet', delete: 'a' }]);
        expect(totals(book, 'b')).toEqual([REF, REF, REF, REF]);
        applyOps(book, inverse);
        expect(totals(book, 'b')).toEqual([53, 55, 53, 63]);
        expect(totals(book)).toEqual([53, 55, 53, 63]);
    });

    test('a refused batch that hid a row before it was refused leaves every total', () => {
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED)));
        const before = bytes(book);
        const refused = () => applyOps(book, [hide(4, 5), filterColumn('j', [[0, 0]]), { kind: 'sheet', delete: 'a' }]);
        expect(refused).toThrow(Refusal);
        expect(bytes(book)).toBe(before);
        expect(totals(book)).toEqual([53, 55, 53, 63]);
    });

    // The sheet comes back as it was when it was deleted, and the rest of the take-back hides its row again.
    test('a refused batch that showed a row and deleted its sheet takes both back', () => {
        const reader = sheetOf('b', {
            fields: { name: 'b', order: 'a1' },
            cells: TOTALS.map((f, row): Placed<CellRecord> => [row, 2, { f: f.replace('R1C1', '[a]!R1C1') }]),
        });
        const book = new Workbook(bookOf(sheetOf('a', HIDDEN_AND_FILTERED), reader));
        const before = bytes(book);
        const refused = () =>
            applyOps(book, [show(1, 1), { kind: 'sheet', delete: 'a' }, { kind: 'sheet', delete: 'b' }]);
        expect(refused).toThrow(Refusal);
        expect(bytes(book)).toBe(before);
        expect(totals(book, 'b')).toEqual([53, 55, 53, 63]);
    });

    test('a filter column of a snapshot whose filter is not there leaves out no row', () => {
        const orphan = { filterColumn: { k: { filter: 'gone', column: 0, rows: [[3, 3] as const] } } };
        const book = new Workbook(bookOf(sheetOf('a', { records: { ...orphan } })));
        book.engine.recalc(Number.MAX_SAFE_INTEGER);
        expect(TOTALS.map((_, row) => book.engine.valueOf('a', row, 2))).toEqual([63, 63, 63, 63]);
    });
});
