import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS, MAX_STORED_LENGTH } from '@workspace/formula/text';
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import type {
    Batch,
    CellAttrs,
    FormatOp,
    InputOp,
    LinesOp,
    Op,
    RecordOp,
    Rect,
    SheetContent,
    SheetFields,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import {
    batchOf,
    randomBookContent,
    randomEndOp,
    randomFormatOp,
    randomInputOp,
    randomLineReaderOp,
    randomLinesOp,
    randomRecordOp,
    randomSheetOp,
} from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { expectReads, modelAfter, modelOf } from './model';
import { chartOf, formulaRule, ref } from './records-fixtures';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
const RICH = [
    { v: 'bold ', bl: 1 as const },
    { v: 'red', fc: '#ff0000' },
];
const KEPT = "='[b.xlsx]S'!R1C1";
const BOLD: CellAttrs = { bl: 1 };
const ITALIC: CellAttrs = { it: 1, fc: '#ff0000' };

function sheetOf(id: string, part: Partial<SheetContent> = {}, fields: Partial<SheetFields> = {}): SheetContent {
    return {
        id,
        fields: { name: id, order: id, ...fields },
        cells: [],
        looks: [],
        bands: [],
        rows: [],
        columns: [],
        records: {},
        ...part,
    };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000.5, seed: 7, computed: false, sheets };
}

function lines(rows: boolean, insert: boolean, index: number, count = 1, like?: number, sheet = 'a'): LinesOp {
    return { kind: 'lines', sheet, rows, insert, index, count, ...(like !== undefined && { like }) };
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

// The whole look of a cell as a format says it: the look set, every other look key cleared.
function wholeLook(sheet: string, ranges: Rect[], set: CellAttrs): FormatOp {
    return { kind: 'format', sheet, ranges, set, clear: LOOK_KEYS.filter((key) => set[key] === undefined) };
}

// Lands the ops on a book of the content and holds the result to the laws: every place reads as the model after
// them (law 8, with the bands in their one form, law 6), the inverse passes the validators and restores the bytes,
// and its own inverse restores the bytes after the ops (LAW 2). Returns the inverse.
function landed(content: Book, ...ops: Op[]): Op[] {
    const book = new Workbook(content);
    const before = bytes(book);
    const model = modelOf(content);
    const expected = modelAfter(model, { now: content.now, seed: content.seed, ops });
    if (typeof expected === 'string') throw new Error(`the model refuses: ${expected}`);
    const inverse = applyOps(book, ops);
    book.setClock(content.now, content.seed);
    expectReads(book, expected);
    const after = bytes(book);
    const text = JSON.stringify({ g: content.g, now: content.now, seed: content.seed, ops: inverse });
    expect(readBatch(text)).toEqual(JSON.parse(text));
    const again = applyOps(book, inverse);
    book.setClock(content.now, content.seed);
    expect(bytes(book)).toBe(before);
    expectReads(book, model);
    applyOps(book, again);
    book.setClock(content.now, content.seed);
    expect(bytes(book)).toBe(after);
    return inverse;
}

function kinds(ops: readonly Op[]): string[] {
    return ops.map((op) => (op.kind === 'format' ? ('lines' in op ? 'line format' : 'cell format') : op.kind));
}

describe('engine/book/apply-lines — an insert', () => {
    const content = () =>
        bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { v: 1 }],
                    [1, 0, { v: 2 }],
                    [2, 0, { f: '=R[-1]C*2' }],
                    [3, 0, { s: RICH, link: LINK }],
                    [1, 2, { v: 'q', qp: 1 }],
                ],
                looks: [BOLD, ITALIC],
                bands: [0, 3, 1, 1, 2, 2, 3, 0, 2, 2, 0, 1, 5, 0],
                rows: [[[1, 2], { size: 30 }]],
                columns: [[[0, 1], { size: 80, custom: 1 }]],
                records: {
                    merge: { m: { rect: [1, 1, 4, 3] } },
                    comment: { c: { row: 3, column: 0 } },
                    validation: {
                        v: {
                            ranges: [[0, 0, LAST_ROW, 0]],
                            order: 'a',
                            rule: { type: 'dropdown', type2: '', value1: 'a,b', value2: '' },
                        },
                    },
                },
            }),
        );

    test('its inverse is the delete of the new lines alone, rows and columns, whatever `like` said', () => {
        expect(landed(content(), lines(true, true, 2, 3, 1))).toEqual([lines(true, false, 2, 3)]);
        expect(landed(content(), lines(true, true, 2, 3, 2))).toEqual([lines(true, false, 2, 3)]);
        expect(landed(content(), lines(true, true, 0, 2))).toEqual([lines(true, false, 0, 2)]);
        expect(landed(content(), lines(false, true, 1, 2, 0))).toEqual([lines(false, false, 1, 2)]);
        expect(landed(content(), lines(false, true, 2, 1, 2))).toEqual([lines(false, false, 2, 1)]);
    });

    test('the new rows wear the whole look of the row `like`: the one before, the one pushed on, or plain', () => {
        const lookAt = (op: LinesOp, row: number, column: number) => {
            const book = new Workbook(content());
            applyOps(book, [op]);
            const part = book.sheets.get('a');
            return part && book.looks.look(part.bands.look(row, column));
        };
        // Row 1 is bold and row 2 italic in column 0.
        expect(lookAt(lines(true, true, 2, 2, 1), 2, 0)).toEqual(BOLD);
        expect(lookAt(lines(true, true, 2, 2, 1), 3, 0)).toEqual(BOLD);
        expect(lookAt(lines(true, true, 2, 2, 2), 2, 0)).toEqual(ITALIC);
        expect(lookAt(lines(true, true, 2, 2), 2, 0)).toEqual({});
        expect(lookAt(lines(true, true, 2, 2), 4, 0)).toEqual(ITALIC);
        // Column 1 is plain and column 2 bold in row 0.
        expect(lookAt(lines(false, true, 2, 2, 1), 0, 2)).toEqual({});
        expect(lookAt(lines(false, true, 2, 2, 2), 0, 3)).toEqual(BOLD);
        expect(lookAt(lines(false, true, 2, 2), 0, 2)).toEqual({});
        expect(lookAt(lines(false, true, 2, 2), 0, 4)).toEqual(BOLD);
    });

    test('the new lines hold no line key, beside a keyed line either way', () => {
        const book = new Workbook(content());
        applyOps(book, [lines(true, true, 2, 2, 1), lines(false, true, 1, 1, 1)]);
        expect(book.sheets.get('a')?.rows.content()).toEqual([
            [[1, 1], { size: 30 }],
            [[4, 4], { size: 30 }],
        ]);
        expect(book.sheets.get('a')?.columns.content()).toEqual([
            [[0, 0], { size: 80, custom: 1 }],
            [[2, 2], { size: 80, custom: 1 }],
        ]);
    });

    test('a sheet the workbook does not hold is skipped alone', () => {
        const book = new Workbook(content());
        const before = bytes(book);
        expect(
            applyOps(book, [lines(true, true, 0, 1, undefined, 'gone'), lines(true, false, 0, 1, undefined, 'gone')]),
        ).toEqual([]);
        expect(bytes(book)).toBe(before);
    });

    // Five rows inserted stop a range at the grid's last row, which the delete does not give back: the engine
    // reports the text, and the inverse writes it after the delete, where the cell stands then.
    const reads = '=SUM(R1C1:R1048576C1)';
    const lossy = () =>
        bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { v: 1 }],
                    [9, 1, { f: reads, link: LINK }],
                    [1, 2, { f: reads }],
                ],
            }),
            sheetOf('b', { cells: [[4, 4, { f: '=SUM([a]!R1C1:R1048576C1)', qp: 1 }]] }),
        );

    test('a formula the insert makes lossy rides in an input after the delete, in its place after the delete', () => {
        expect(landed(lossy(), lines(true, true, 3, 5))).toEqual([
            lines(true, false, 3, 5),
            {
                kind: 'input',
                sheet: 'a',
                cells: [
                    [9, 1, { f: reads, link: LINK }],
                    [1, 2, { f: reads }],
                ],
            },
            { kind: 'input', sheet: 'b', cells: [[4, 4, { f: '=SUM([a]!R1C1:R1048576C1)', qp: 1 }]] },
        ]);
    });

    test('lossy formulas of a column insert are placed by their column after the delete', () => {
        const across = '=SUM(R1C1:R1C16384)';
        const book = bookOf(sheetOf('a', { cells: [[3, 6, { f: across }]] }));
        expect(landed(book, lines(false, true, 2, 3))).toEqual([
            lines(false, false, 2, 3),
            { kind: 'input', sheet: 'a', cells: [[3, 6, { f: across }]] },
        ]);
    });

    test('a rule whose formula the insert makes lossy comes back whole, between the delete and the inputs', () => {
        const rule = formulaRule([[0, 3, 5, 3]], '=SUM(R1C1:R1048576C1)>0');
        const book = bookOf(
            sheetOf('a', { cells: [[1, 2, { f: reads }]] }),
            sheetOf('b', {
                records: { conditionalFormat: { r: formulaRule([[0, 0, 2, 0]], '=SUM([a]!R1C1:R1048576C1)>0') } },
            }),
            sheetOf('c', { records: { conditionalFormat: { r: rule } } }),
        );
        const inverse = landed(book, lines(true, true, 3, 5));
        expect(kinds(inverse)).toEqual(['lines', 'record', 'input']);
        expect(inverse[1]).toMatchObject({ sheet: 'b', type: 'conditionalFormat', id: 'r', whole: 1 });
    });
});

describe('engine/book/apply-lines — a delete', () => {
    test('(1) its inverse opens with the insert of plain lines, with no `like`', () => {
        const book = bookOf(sheetOf('a', { cells: [[9, 0, { v: 1 }]] }));
        expect(landed(book, lines(true, false, 2, 3))[0]).toEqual(lines(true, true, 2, 3));
        expect(landed(book, lines(false, false, 2, 3))[0]).toEqual(lines(false, true, 2, 3));
    });

    test('(4) lines that hold nothing give no content op: the insert leaves them empty', () => {
        const book = bookOf(sheetOf('a', { cells: [[9, 0, { v: 1 }]] }));
        expect(landed(book, lines(true, false, 2, 3))).toEqual([lines(true, true, 2, 3)]);
        expect(landed(book, lines(false, false, 1, 1))).toEqual([lines(false, true, 1, 1)]);
    });

    test('(2) the looks of deleted rows come back whole, one op per look over joined rectangles', () => {
        // Row 4 is bold across the sheet; rows 5 and 6 are italic in columns 0 to 1 and 2 to 3, two bands.
        const book = bookOf(
            sheetOf('a', {
                looks: [BOLD, ITALIC, { bg: '#00ff00' }],
                bands: [0, 3, 4, 1, 5, 2, 7, 0, 2, 4, 4, 1, 5, 2, 7, 0, 9, 3, 4, 2, 4, 1, 5, 0],
            }),
        );
        const inverse = landed(book, lines(true, false, 4, 3));
        expect(inverse).toEqual([
            lines(true, true, 4, 3),
            wholeLook('a', [[4, 0, 4, LAST_COLUMN]], BOLD),
            wholeLook('a', [[5, 0, 6, 3]], ITALIC),
        ]);
    });

    test('(2) the looks of deleted columns come back whole', () => {
        const book = bookOf(sheetOf('a', { looks: [BOLD, ITALIC], bands: [1, 2, 0, 1, 3, 2, 2, 2, 0, 1, 3, 0, 3, 0] }));
        expect(landed(book, lines(false, false, 1, 2)).slice(0, 3)).toEqual([
            lines(false, true, 1, 2),
            wholeLook('a', [[0, 1, 2, 2]], BOLD),
            wholeLook('a', [[3, 1, LAST_ROW, 1]], ITALIC),
        ]);
    });

    test('the lines that enter at the grid’s end wear the look of the last line that stays', () => {
        // Column 0 is italic from row 10 to the last row, and the last column is bold.
        const book = new Workbook(
            bookOf(sheetOf('a', { looks: [ITALIC, BOLD], bands: [0, 1, 10, 1, 1, 0, LAST_COLUMN, 1, 0, 2] })),
        );
        applyOps(book, [lines(true, false, 2, 5), lines(false, false, 3, 4)]);
        const part = book.sheets.get('a');
        expect(part?.bands.content()).toEqual({
            looks: [1, 2],
            bands: [0, 2, 0, 0, 5, 1, 1, 0, LAST_COLUMN - 4, 1, 0, 2],
        });
        // The inverse inserts push those lines off again: they are EMPTY.
        landed(
            bookOf(sheetOf('a', { looks: [ITALIC, BOLD], bands: [0, 1, 10, 1, 1, 0, LAST_COLUMN, 1, 0, 2] })),
            lines(true, false, 2, 5),
            lines(false, false, 3, 4),
        );
    });

    test('(3) the line keys of the deleted lines come back, one op per distinct keys', () => {
        const book = bookOf(
            sheetOf('a', {
                rows: [
                    [[3, 5], { size: 30 }],
                    [[6, 6], { hidden: 1 }],
                    [[8, 9], { size: 30 }],
                ],
                columns: [[[0, 0], { size: 80, custom: 1 }]],
            }),
        );
        expect(landed(book, lines(true, false, 4, 5))).toEqual([
            lines(true, true, 4, 5),
            {
                kind: 'format',
                sheet: 'a',
                lines: 'rows',
                spans: [
                    [4, 5],
                    [8, 8],
                ],
                set: { size: 30 },
            },
            { kind: 'format', sheet: 'a', lines: 'rows', spans: [[6, 6]], set: { hidden: 1 } },
        ]);
        expect(landed(book, lines(false, false, 0, 2)).slice(0, 2)).toEqual([
            lines(false, true, 0, 2),
            { kind: 'format', sheet: 'a', lines: 'columns', spans: [[0, 0]], set: { size: 80, custom: 1 } },
        ]);
    });

    test('(4) the content of the deleted lines comes back in one input: values, formulas, runs, links, marks', () => {
        const book = bookOf(
            sheetOf('a', {
                cells: [
                    [2, 0, { v: 1 }],
                    [3, 0, { f: '=R[5]C+1' }],
                    [2, 1, { f: KEPT, v: 4 }],
                    [3, 1, { s: RICH, link: LINK }],
                    [2, 2, { v: 'q', qp: 1 }],
                    [3, 2, { link: LINK }],
                    [2, 3, { v: '#N/A', e: 1 }],
                    [8, 0, { v: 7 }],
                ],
            }),
        );
        expect(landed(book, lines(true, false, 2, 2))).toEqual([
            lines(true, true, 2, 2),
            {
                kind: 'input',
                sheet: 'a',
                cells: [
                    [2, 0, { v: 1 }],
                    [3, 0, { f: '=R[5]C+1' }],
                    [2, 1, { f: KEPT, v: 4 }],
                    [3, 1, { s: RICH, link: LINK }],
                    [2, 2, { v: 'q', qp: 1 }],
                    [3, 2, { link: LINK }],
                    [2, 3, { v: '#N/A', e: 1 }],
                ],
            },
        ]);
        const columns = landed(book, lines(false, false, 1, 1));
        expect(columns).toEqual([
            lines(false, true, 1, 1),
            {
                kind: 'input',
                sheet: 'a',
                cells: [
                    [2, 1, { f: KEPT, v: 4 }],
                    [3, 1, { s: RICH, link: LINK }],
                ],
            },
        ]);
    });

    test('(5) the records the delete removes or clips come back, on the sheet and on another, the freeze too', () => {
        const chart = chartOf({ categories: null, series: [{ id: 's', name: 'n', values: ref('a', [2, 3], [0, 0]) }] });
        const rule = formulaRule([[0, 0, 2, 0]], '=[a]!R3C1>0');
        const book = bookOf(
            sheetOf(
                'a',
                {
                    records: {
                        merge: { m: { rect: [1, 1, 4, 3] }, gone: { rect: [2, 5, 3, 6] } },
                        comment: { c: { row: 3, column: 0 }, stays: { row: 6, column: 0 } },
                        filter: { f: { rect: [2, 0, 9, 3] } },
                        filterColumn: { k: { filter: 'f', column: 1, rows: [[4, 5]] } },
                    },
                },
                { frozenRows: 3 },
            ),
            sheetOf('b', { records: { chart: { g: chart }, conditionalFormat: { r: rule } } }),
        );
        const inverse = landed(book, lines(true, false, 2, 2));
        const records = inverse.filter((op): op is RecordOp => op.kind === 'record');
        expect(kinds(inverse)).toEqual(['lines', ...records.map(() => 'record')]);
        expect(records).toEqual([
            { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { frozenRows: 3 } },
            { kind: 'record', sheet: 'a', type: 'merge', id: 'gone', set: { rect: [2, 5, 3, 6] }, whole: 1 },
            { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [2, 0, 9, 3] }, whole: 1 },
            {
                kind: 'record',
                sheet: 'a',
                type: 'filterColumn',
                id: 'k',
                set: { filter: 'f', column: 1, rows: [[4, 5]] },
                whole: 1,
            },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 3, column: 0 }, whole: 1 },
            { kind: 'record', sheet: 'b', type: 'conditionalFormat', id: 'r', set: rule, whole: 1 },
            { kind: 'record', sheet: 'b', type: 'chart', id: 'g', set: chart },
        ]);
    });

    test('(6) the formulas the delete breaks come back last, in their places before the delete, on every sheet', () => {
        const book = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { f: '=R[3]C+1' }],
                    [3, 0, { v: 5 }],
                    [7, 0, { f: '=R[-4]C+1', link: LINK }],
                    [8, 0, { f: '=R[-4]C+1' }],
                ],
            }),
            sheetOf('b', {
                cells: [
                    [1, 1, { f: '=SUM([a]!R4C1:R5C1)' }],
                    [2, 1, { f: '=[a]!R4C1' }],
                ],
            }),
        );
        const inverse = landed(book, lines(true, false, 3, 2));
        expect(kinds(inverse)).toEqual(['lines', 'input', 'input', 'input']);
        expect(inverse.slice(2)).toEqual([
            {
                kind: 'input',
                sheet: 'a',
                cells: [
                    [0, 0, { f: '=R[3]C+1' }],
                    [7, 0, { f: '=R[-4]C+1', link: LINK }],
                    [8, 0, { f: '=R[-4]C+1' }],
                ],
            },
            {
                kind: 'input',
                sheet: 'b',
                cells: [
                    [1, 1, { f: '=SUM([a]!R4C1:R5C1)' }],
                    [2, 1, { f: '=[a]!R4C1' }],
                ],
            },
        ]);
    });

    test('(6) the lossy formulas come back one op per sheet in tab order, whatever order the sheets were loaded in', () => {
        // Sheet c moves before a, so a reader that loads the book now holds it first; sheet b has none.
        const book = new Workbook(
            bookOf(
                sheetOf('a', { cells: [[0, 0, { f: '=R3C2' }]] }),
                sheetOf('b', { cells: [[0, 0, { v: 1 }]] }),
                sheetOf('c', { cells: [[0, 1, { f: '=[a]!R3C2' }]] }),
            ),
        );
        applyOps(book, [{ kind: 'record', sheet: 'c', type: 'sheet', id: 'c', set: { order: '0' } }]);
        const inverse = applyOps(book, [lines(true, false, 2, 1)]);
        expect(inverse.slice(-2)).toEqual([
            { kind: 'input', sheet: 'c', cells: [[0, 1, { f: '=[a]!R3C2' }]] },
            { kind: 'input', sheet: 'a', cells: [[0, 0, { f: '=R3C2' }]] },
        ]);
    });

    test('(6) a run of one lossy formula that the deleted lines stood inside is written back in two parts', () => {
        // A filled column reads row 3; the rows above and below the deleted one hold one text, side by side after it.
        const book = bookOf(
            sheetOf('a', {
                cells: [
                    [2, 0, { v: 5 }],
                    [0, 2, { f: '=R3C1+1' }],
                    [1, 2, { f: '=R3C1+1' }],
                    [3, 2, { f: '=R3C1+1' }],
                    [4, 2, { f: '=R3C1+1' }],
                ],
            }),
        );
        const inverse = landed(book, lines(true, false, 2, 1));
        expect(inverse.at(-1)).toEqual({
            kind: 'input',
            sheet: 'a',
            runs: [
                [[0, 2, 1, 2], { f: '=R3C1+1' }],
                [[3, 2, 4, 2], { f: '=R3C1+1' }],
            ],
        });
    });

    test('the parts come in one order: lines, looks, line keys, content, records, lossy formulas', () => {
        const book = bookOf(
            sheetOf('a', {
                cells: [
                    [2, 0, { v: 1 }],
                    [5, 0, { f: '=R[-3]C' }],
                ],
                looks: [BOLD],
                bands: [0, 2, 2, 1, 3, 0],
                rows: [[[2, 2], { hidden: 1 }]],
                records: { comment: { c: { row: 2, column: 0 } } },
            }),
        );
        expect(kinds(landed(book, lines(true, false, 2, 1)))).toEqual([
            'lines',
            'cell format',
            'line format',
            'input',
            'record',
            'input',
        ]);
    });

    test('a delete of every row and of every column is undone', () => {
        const book = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { v: 1 }],
                    [5, 2, { f: '=R1C1' }],
                ],
                looks: [BOLD],
                bands: [0, 1, 0, 1, 3, 0],
                rows: [[[1, 2], { size: 30 }]],
            }),
            sheetOf('b', { cells: [[0, 0, { f: '=[a]!R1C1' }]] }),
        );
        landed(book, lines(true, false, 0, GRID_ROWS));
        landed(book, lines(false, false, 0, GRID_COLUMNS));
    });
});

describe('engine/book/apply-lines — a filter’s first line moves as a line, its end on the grid’s last stays', () => {
    test('a filter over every row: an insert at row 0 moves its header down, and the undo gives it back', () => {
        const book = bookOf(sheetOf('a', { records: { filter: { f: { rect: [0, 0, LAST_ROW, 4] } } } }));
        const inverse = landed(book, lines(true, true, 0, 1));
        expect(inverse).toEqual([lines(true, false, 0, 1)]);
        const after = new Workbook(book);
        applyOps(after, [lines(true, true, 0, 1)]);
        expect(after.sheets.get('a')?.records.records('filter').get('f')).toEqual({ rect: [1, 0, LAST_ROW, 4] });
    });

    test('a filter from row 2 to the last row: a delete above it, its undo and the undo of that', () => {
        const book = bookOf(sheetOf('a', { records: { filter: { f: { rect: [2, 0, LAST_ROW, 4] } } } }));
        expect(landed(book, lines(true, false, 0, 2))).toEqual([lines(true, true, 0, 2)]);
        const after = new Workbook(book);
        applyOps(after, [lines(true, false, 0, 2)]);
        expect(after.sheets.get('a')?.records.records('filter').get('f')).toEqual({ rect: [0, 0, LAST_ROW, 4] });
    });

    // The filter's span along the edited axis before and after, at, above and below its first line and at the grid's
    // end; on rows a delete of the first line, the header, removes it, on columns it clips it.
    const LAST = 'last';
    type Along = [number, number | typeof LAST];
    const cases: [string, Along, boolean, number, number, Along | null, Along][] = [
        ['every line, an insert at its first', [0, LAST], true, 0, 1, [1, LAST], [1, LAST]],
        ['every line, an insert below its first', [0, LAST], true, 4, 2, [0, LAST], [0, LAST]],
        ['every line, an insert at the grid’s end', [0, LAST], true, -1, 1, [0, LAST], [0, LAST]],
        ['every line, a delete of its first', [0, LAST], false, 0, 1, null, [0, LAST]],
        ['every line, a delete below its first', [0, LAST], false, 4, 2, [0, LAST], [0, LAST]],
        ['every line, a delete at the grid’s end', [0, LAST], false, -2, 2, [0, LAST], [0, LAST]],
        ['to the end, an insert at its first', [3, LAST], true, 3, 1, [4, LAST], [4, LAST]],
        ['to the end, an insert above', [3, LAST], true, 0, 2, [5, LAST], [5, LAST]],
        ['to the end, an insert below its first', [3, LAST], true, 5, 1, [3, LAST], [3, LAST]],
        ['to the end, an insert at the grid’s end', [3, LAST], true, -1, 1, [3, LAST], [3, LAST]],
        ['to the end, a delete above', [3, LAST], false, 0, 2, [1, LAST], [1, LAST]],
        ['to the end, a delete of its first', [3, LAST], false, 3, 1, null, [3, LAST]],
        ['to the end, a delete across its first', [3, LAST], false, 2, 3, null, [2, LAST]],
        ['to the end, a delete below its first', [3, LAST], false, 5, 1, [3, LAST], [3, LAST]],
        ['to the end, a delete at the grid’s end', [3, LAST], false, -2, 2, [3, LAST], [3, LAST]],
        ['closed, an insert at its first', [3, 9], true, 3, 1, [4, 10], [4, 10]],
        ['closed, an insert above', [3, 9], true, 0, 1, [4, 10], [4, 10]],
        ['closed, an insert below its first', [3, 9], true, 5, 1, [3, 10], [3, 10]],
        ['closed, an insert at the grid’s end', [3, 9], true, -1, 1, [3, 9], [3, 9]],
        ['closed, a delete above', [3, 9], false, 0, 2, [1, 7], [1, 7]],
        ['closed, a delete of its first', [3, 9], false, 3, 1, null, [3, 8]],
        ['closed, a delete below its first', [3, 9], false, 5, 1, [3, 8], [3, 8]],
        ['closed, a delete at the grid’s end', [3, 9], false, -2, 2, [3, 9], [3, 9]],
    ];
    for (const [name, [start, end], insert, at, count, onRows, onColumns] of cases) {
        for (const rows of [true, false]) {
            test(`${rows ? 'rows' : 'columns'}: ${name}`, () => {
                const last = rows ? LAST_ROW : LAST_COLUMN;
                const line = (along: number | typeof LAST) => (along === LAST ? last : along);
                const rect = ([first, final]: Along): Rect =>
                    rows ? [first, 1, line(final), 4] : [1, first, 4, line(final)];
                const index = at < 0 ? last + 1 + at : at;
                // A column of the filter that hides two rows of it.
                const column: { column: number; rows: Span[] } = rows
                    ? { column: 2, rows: [[start + 2, start + 3]] }
                    : { column: start + 2, rows: [[2, 3]] };
                const records = {
                    filter: { f: { rect: rect([start, end]) } },
                    filterColumn: { k: { filter: 'f', ...column } },
                };
                const book = bookOf(sheetOf('a', { records }));
                landed(book, lines(rows, insert, index, count));
                const after = new Workbook(book);
                applyOps(after, [lines(rows, insert, index, count)]);
                const expected = rows ? onRows : onColumns;
                const filter = after.sheets.get('a')?.records.records('filter').get('f');
                expect(filter).toEqual(expected ? { rect: rect(expected) } : undefined);
            });
        }
    }
});

// A book with something of every part near the top, on which the landing ops land whatever stands on its last lines.
function base(part: Partial<SheetContent> = {}, other: Partial<SheetContent> = {}): Book {
    return bookOf(
        sheetOf('a', {
            cells: [
                [0, 0, { v: 2 }],
                [1, 0, { f: '=R[-1]C*2' }],
                [2, 1, { s: RICH }],
            ],
            ...part,
        }),
        sheetOf('b', { cells: [[0, 0, { f: '=[a]!R1C1' }]], ...other }),
    );
}

// Ops that land on `base` and change its bytes, a row delete among them, which moves what stands on the last rows.
const LANDING: readonly Op[] = [
    { kind: 'input', sheet: 'a', cells: [[0, 3, { v: 'x', link: LINK }]] },
    lines(true, false, 1, 1),
    { kind: 'format', sheet: 'a', ranges: [[0, 0, 2, 2]], set: { it: 1 } },
    lines(true, true, 0, 1, 0),
    { kind: 'record', sheet: 'a', type: 'comment', id: 'new', set: { row: 1, column: 1 }, whole: 1 },
];
const TRAILING: RecordOp = { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { color: '#ff0000' } };

const DROPDOWN = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
// A formula as long as a cell stores, made of one term. A row inserted between a cell and the row it reads nine rows
// up grows every such term by a character, and rows inserted above a row that is named grow its number.
function longOf(term: string): string {
    const inner = `SUM(${Array.from({ length: 200 }, () => term).join(',')})`;
    const groups = Math.floor((MAX_STORED_LENGTH - 6) / (inner.length + 1));
    return `=SUM(${Array.from({ length: groups }, () => inner).join(',')})`;
}
const LONG = longOf('R[-9]C');
// A chart on the edge of its size bound, whose refs to sheet a grow when a million rows are inserted above them.
const bigChart = (() => {
    const padded = (length: number) =>
        chartOf({
            categories: null,
            series: Array.from({ length: 32 }, (_, i) => ({
                id: `s-${i}`,
                name: 'n'.repeat(length),
                values: ref('a', [0, 0], [i, i]),
            })),
        });
    let length = 1;
    while (!exceedsChartSpecBytes(padded(length + 1))) length += 1;
    return padded(length);
})();

// One clause of EMPTY each: the book, and the insert that is refused on it, three rows or one column, above and
// before cells of the book, so an insert that reached the engine would show.
const rowsIn = lines(true, true, 1, 3);
const columnIn = lines(false, true, 1, 1);
const END = LAST_ROW - 1;
const REFUSED: readonly [string, RefusalKey, Book, LinesOp][] = [
    [
        'content on a pushed row, which the engine refuses',
        'grid-end',
        base({
            cells: [
                [0, 0, { v: 2 }],
                [LAST_ROW, 0, { v: 1 }],
            ],
        }),
        rowsIn,
    ],
    [
        'content on the last column, which the engine refuses',
        'grid-end',
        base({
            cells: [
                [0, 0, { v: 2 }],
                [0, LAST_COLUMN, { f: '=1+1' }],
            ],
        }),
        columnIn,
    ],
    [
        'a link alone on a pushed row',
        'grid-end',
        base({
            cells: [
                [0, 0, { v: 2 }],
                [LAST_ROW, 0, { link: LINK }],
            ],
        }),
        rowsIn,
    ],
    [
        'a mark alone on the last column',
        'grid-end',
        base({
            cells: [
                [0, 0, { v: 2 }],
                [3, LAST_COLUMN, { qp: 1 }],
            ],
        }),
        columnIn,
    ],
    ['a line key on a pushed row', 'grid-end', base({ rows: [[[LAST_ROW, LAST_ROW], { size: 30 }]] }), rowsIn],
    [
        'a line key on the last column',
        'grid-end',
        base({ columns: [[[LAST_COLUMN, LAST_COLUMN], { hidden: 1 }]] }),
        columnIn,
    ],
    [
        'a look on a pushed row that the last row that stays does not wear',
        'grid-end',
        base({ looks: [BOLD], bands: [2, 1, LAST_ROW, 1, 3, 0] }),
        rowsIn,
    ],
    [
        'a look on the last column that the column before does not wear',
        'grid-end',
        base({ looks: [BOLD], bands: [LAST_COLUMN, 1, 4, 1] }),
        columnIn,
    ],
    [
        'a comment on a pushed row',
        'grid-end',
        base({ records: { comment: { c: { row: LAST_ROW, column: 2 } } } }),
        rowsIn,
    ],
    [
        'a comment on the last column',
        'grid-end',
        base({ records: { comment: { c: { row: 2, column: LAST_COLUMN } } } }),
        columnIn,
    ],
    [
        'a merge that reaches a pushed row',
        'grid-end',
        base({ records: { merge: { m: { rect: [END - 4, 0, END, 1] } } } }),
        rowsIn,
    ],
    [
        'a merge that reaches the last column',
        'grid-end',
        base({ records: { merge: { m: { rect: [8, LAST_COLUMN - 1, 8, LAST_COLUMN] } } } }),
        columnIn,
    ],
    [
        'a filter that ends on a pushed row',
        'grid-end',
        base({ records: { filter: { f: { rect: [8, 0, END, 3] } } } }),
        rowsIn,
    ],
    [
        'a rule range that starts on a pushed row',
        'grid-end',
        base({ records: { conditionalFormat: { r: formulaRule([[LAST_ROW, 0, LAST_ROW, 0]], '=RC>1') } } }),
        rowsIn,
    ],
    [
        'a dropdown range that starts on the last column',
        'grid-end',
        base({
            records: { validation: { v: { ranges: [[0, LAST_COLUMN, 3, LAST_COLUMN]], order: 'a', rule: DROPDOWN } } },
        }),
        columnIn,
    ],
    [
        'filtered rows that end on a pushed row',
        'grid-end',
        base({
            records: {
                filter: { f: { rect: [8, 0, LAST_ROW, 3] } },
                filterColumn: { k: { filter: 'f', column: 1, rows: [[END - 1, END]] } },
            },
        }),
        rowsIn,
    ],
    [
        'a formula the engine would write past the stored bound',
        'key-too-long',
        base({
            cells: [
                [0, 0, { v: 2 }],
                [30, 5, { f: LONG }],
            ],
        }),
        lines(true, true, 25, 1),
    ],
    [
        'a rule formula that would pass the stored bound',
        'key-too-long',
        base({ records: { conditionalFormat: { r: formulaRule([[30, 5, 40, 5]], LONG) } } }),
        lines(true, true, 25, 1),
    ],
    [
        'a rule formula on another sheet that would pass the stored bound',
        'key-too-long',
        base(
            {},
            {
                records: {
                    conditionalFormat: { r: formulaRule([[0, 0, 4, 0]], longOf('[a]!R9C1')) },
                },
            },
        ),
        lines(true, true, 5, 1_000),
    ],
    [
        'a chart on another sheet whose refs would take it past its size bound',
        'key-too-long',
        base({}, { records: { chart: { g: bigChart } } }),
        lines(true, true, 0, 1_000_000),
    ],
];

describe('engine/book/apply-lines — LAW 1: a refused insert leaves the bytes as they were', () => {
    for (const [what, key, content, refused] of REFUSED) {
        for (let k = 0; k <= LANDING.length; k += 1) {
            test(`${key} by ${what}, at op ${k}`, () => {
                const book = new Workbook(content);
                const before = bytes(book);
                const ops = [...LANDING.slice(0, k), refused, TRAILING];
                expect(modelAfter(modelOf(content), { now: 1, seed: 1, ops })).toBe(key);
                expect(refusalOf(() => applyOps(book, ops))).toBe(key);
                expect(bytes(book)).toBe(before);
                expectReads(book, modelOf(content));
                // The same ops without the refused one land, so the refusal took something back.
                landed(content, ...LANDING.slice(0, k), TRAILING);
                const other = new Workbook(content);
                applyOps(other, [...LANDING.slice(0, k), TRAILING]);
                expect(bytes(other)).not.toBe(before);
            });
        }
    }

    const OPEN: readonly [string, Partial<SheetContent>, LinesOp][] = [
        [
            'a look that the last row that stays wears to the grid’s end',
            { looks: [BOLD], bands: [2, 1, 9, 1, 3, 0] },
            rowsIn,
        ],
        ['a look that the last columns all wear', { looks: [BOLD], bands: [9, 1, 4, 1] }, columnIn],
        [
            'a filter that reaches the last row',
            {
                records: {
                    filter: { f: { rect: [8, 0, LAST_ROW, 3] } },
                    filterColumn: { k: { filter: 'f', column: 1, rows: [[9, LAST_ROW]] } },
                },
            },
            rowsIn,
        ],
        [
            'rule and dropdown ranges that reach the last row',
            {
                records: {
                    conditionalFormat: { r: formulaRule([[8, 0, LAST_ROW, 0]], '=RC>1') },
                    validation: { v: { ranges: [[END - 1, 0, LAST_ROW, 0]], order: 'a', rule: DROPDOWN } },
                },
            },
            lines(true, true, 5, 1),
        ],
        [
            'a rule range that reaches the last column',
            { records: { conditionalFormat: { r: formulaRule([[0, 9, 3, LAST_COLUMN]], '=RC>1') } } },
            columnIn,
        ],
        [
            'content and keys just before the pushed lines',
            {
                cells: [
                    [0, 0, { v: 2 }],
                    [LAST_ROW - 3, 0, { link: LINK }],
                ],
                rows: [[[LAST_ROW - 3, LAST_ROW - 3], { size: 30 }]],
                records: { comment: { c: { row: LAST_ROW - 3, column: 0 } } },
            },
            rowsIn,
        ],
    ];
    for (const [what, part, op] of OPEN) {
        test(`an insert lands over ${what}, and its inverse is the delete alone`, () => {
            expect(landed(base(part), op)).toEqual([{ ...op, insert: false }]);
        });
    }

    test('the limits are weighed after the last op only: past them after an insert, within them after a delete', () => {
        // Four columns of a million rows each hold as many slots as a workbook may.
        const content = bookOf(
            sheetOf('a', { cells: [0, 1, 2, 3].map((column) => [999_999, column, { v: 1 }] as const) }),
        );
        const book = new Workbook(content);
        const before = bytes(book);
        expect(refusalOf(() => applyOps(book, [TRAILING, lines(true, true, 0, 1)]))).toBe('too-many-cells');
        expect(bytes(book)).toBe(before);
        expectReads(book, modelOf(content));
        expect(
            refusalOf(() => applyOps(book, [lines(true, true, 0, 1), lines(true, false, 5, 1), TRAILING])),
        ).toBeUndefined();
        expect(bytes(book)).not.toBe(before);
        expect(book.engine.columnLength('a', 0)).toBe(1_000_000);
    });
});

describe('engine/book/apply-lines — the cases of the falsifier’s bounds', () => {
    test('forty rows inserted above a look thirty rows from the end and content on the last row are refused', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [[LAST_ROW, 0, { v: 'last row' }]],
                looks: [{ bg: '#ff0000' }],
                bands: [0, 2, GRID_ROWS - 30, 1, GRID_ROWS - 29, 0],
            }),
        );
        const book = new Workbook(content);
        const before = bytes(book);
        expect(refusalOf(() => applyOps(book, [lines(true, true, 5, 40)]))).toBe('grid-end');
        expect(bytes(book)).toBe(before);
        // Without the content the look alone refuses it, and without the look the content alone.
        const look = new Workbook({ ...content, sheets: [{ ...content.sheets[0], cells: [] }] });
        expect(refusalOf(() => applyOps(look, [lines(true, true, 5, 40)]))).toBe('grid-end');
        const cell = new Workbook({ ...content, sheets: [{ ...content.sheets[0], looks: [], bands: [] }] });
        expect(refusalOf(() => applyOps(cell, [lines(true, true, 5, 40)]))).toBe('grid-end');
    });

    test('a row insert that grows two hundred terms of a key within the bound lands and is undone', () => {
        const key = `=SUM(${Array.from({ length: 200 }, () => 'R[1]C').join(',')})`;
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [3, 0, { f: key }],
                    [4, 0, { v: 1 }],
                ],
            }),
        );
        expect(landed(content, lines(true, true, 4, 1_000_000))).toEqual([lines(true, false, 4, 1_000_000)]);
    });
});

describe('engine/book/apply-lines — LAW 2, law 6 and law 8 over random books and batches', () => {
    test('1,800 batches of line edits mixed with every other kind built', () => {
        const count = { rowInsert: 0, rowDelete: 0, columnInsert: 0, columnDelete: 0, liked: 0, atEnd: 0 };
        // Line edits at or above the first line of a filter that reaches the grid's last line.
        let filterToEnd = 0;
        const reachesUnder = (book: Workbook, { sheet, rows, index }: LinesOp) =>
            [...(book.sheets.get(sheet)?.records.records('filter').values() ?? [])].some(
                ({ rect: [top, left, bottom, right] }) =>
                    rows ? index <= top && bottom === LAST_ROW : index <= left && right === LAST_COLUMN,
            );
        // What the inverses of the lines ops held beyond the lines op itself.
        const parts = { looks: 0, lineKeys: 0, content: 0, records: 0, lost: 0, insertLost: 0 };
        const refused = new Map<string, number>();
        let landedBatches = 0;
        for (let seed = 1; seed <= 600; seed += 1) {
            const random = randomOf(seed);
            const content = randomBookContent(random);
            const book = new Workbook(content);
            let model: Model = modelOf(content);
            for (let round = 0; round < 3; round += 1) {
                const batch: Batch = batchOf(
                    random,
                    model,
                    (r, m): Op => {
                        const draw = r();
                        if (draw < 0.45) return randomLinesOp(r, m);
                        if (draw < 0.57) return randomEndOp(r, m);
                        if (draw < 0.67) return randomLineReaderOp(r, m);
                        if (draw < 0.75) return randomInputOp(r, m);
                        if (draw < 0.83) return randomFormatOp(r, m);
                        return draw < 0.97 ? randomRecordOp(r, m) : randomSheetOp(r, m);
                    },
                    4,
                );
                const before = bytes(book);
                const clock = model;
                const expected = modelAfter(model, batch);
                if (typeof expected === 'string') {
                    refused.set(expected, (refused.get(expected) ?? 0) + 1);
                    expect(refusalOf(() => applyOps(book, batch.ops))).toBe(expected);
                    expect(bytes(book)).toBe(before);
                    expectReads(book, model);
                    continue;
                }
                // Each op alone, so the inverse of each lines op is seen as it is.
                const inverses = batch.ops.map((op) => {
                    if (op.kind === 'lines' && reachesUnder(book, op)) filterToEnd += 1;
                    return applyOps(book, [op]);
                });
                book.setClock(batch.now, batch.seed);
                landedBatches += 1;
                expectReads(book, expected);
                const after = bytes(book);
                const inverse = inverses.toReversed().flat();
                const text = JSON.stringify({ ...batch, ops: inverse });
                expect(readBatch(text)).toEqual(JSON.parse(text));
                const again = applyOps(book, inverse);
                book.setClock(clock.now, clock.seed);
                expect(bytes(book)).toBe(before);
                expectReads(book, model);
                applyOps(book, again);
                book.setClock(batch.now, batch.seed);
                expect(bytes(book)).toBe(after);
                expectReads(book, expected);
                model = expected;
                for (const [at, op] of batch.ops.entries()) {
                    if (op.kind !== 'lines' || inverses[at].length === 0) continue;
                    count[
                        op.rows ? (op.insert ? 'rowInsert' : 'rowDelete') : op.insert ? 'columnInsert' : 'columnDelete'
                    ] += 1;
                    if (op.like !== undefined) count.liked += 1;
                    if (op.index + op.count > (op.rows ? GRID_ROWS : GRID_COLUMNS) - 8) count.atEnd += 1;
                    const [first, ...rest] = inverses[at];
                    expect(first).toEqual({
                        kind: 'lines',
                        sheet: op.sheet,
                        rows: op.rows,
                        insert: !op.insert,
                        index: op.index,
                        count: op.count,
                    });
                    const names = kinds(rest);
                    // The parts stand in their one order.
                    const order = ['cell format', 'line format', 'input', 'record', 'input'];
                    let step = 0;
                    for (const name of names) {
                        while (step < order.length && order[step] !== name) step += 1;
                        expect(step).toBeLessThan(order.length);
                    }
                    if (names.includes('cell format')) parts.looks += 1;
                    if (names.includes('line format')) parts.lineKeys += 1;
                    if (names.includes('record')) parts.records += 1;
                    const inputs = rest.filter((part): part is InputOp => part.kind === 'input');
                    if (op.insert && inputs.length > 0) parts.insertLost += 1;
                    if (!op.insert && inputs[0]?.cells?.some(([, , cell]) => cell !== null)) parts.content += 1;
                    if (!op.insert && inputs.length > 1) parts.lost += 1;
                }
            }
        }
        expect(landedBatches + [...refused.values()].reduce((sum, n) => sum + n, 0)).toBe(1800);
        expect(landedBatches).toBeGreaterThan(1000);
        for (const n of Object.values(count)) expect(n).toBeGreaterThan(100);
        expect(filterToEnd).toBeGreaterThan(20);
        for (const n of Object.values(parts)) expect(n).toBeGreaterThan(20);
        expect(refused.get('grid-end') ?? 0).toBeGreaterThan(50);
    }, 300_000);
});
