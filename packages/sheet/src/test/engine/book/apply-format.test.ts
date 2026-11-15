import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type {
    Batch,
    CellAttrKey,
    CellAttrs,
    FormatOp,
    InputOp,
    LineAttrs,
    Op,
    Rect,
    Run,
    SheetContent,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { CellLink } from '@workspace/lib/sheets/types';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { bytes } from './bytes';
import { expectReads, modelAfter, modelOf } from './model';

type Applied = Parameters<typeof applyOps>[1][number];
type CellSet = CellAttrs & { link?: CellLink };
type CellClear = (CellAttrKey | 'link')[];

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const WHOLE: Rect = [0, 0, LAST_ROW, LAST_COLUMN];
const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const OTHER: CellLink = { type: 'cellrange', address: 'A1:B2' };
const SIDE = { style: 1, color: '#000000' };
const PLAIN_RUNS: Run[] = [{ v: 'one ' }, { v: 'two' }];
const MIXED_RUNS: Run[] = [{ v: 'bold ', bl: 1 }, { v: 'plain' }];
const BOLD_RUNS: Run[] = [
    { v: 'one ', bl: 1 },
    { v: 'two', bl: 1 },
];

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000.5, seed: 7, sheets };
}

function format(ranges: Rect[], set?: CellSet, clear?: CellClear, sheet = 'a'): FormatOp {
    return { kind: 'format', sheet, ranges, ...(set && { set }), ...(clear && { clear }) };
}

function lines(axis: 'rows' | 'columns', spans: Span[], set?: LineAttrs, clear?: (keyof LineAttrs)[]): FormatOp {
    return { kind: 'format', sheet: 'a', lines: axis, spans, ...(set && { set }), ...(clear && { clear }) };
}

function lookAt(book: Workbook, row: number, column: number, sheet = 'a'): Readonly<CellAttrs> {
    return book.looks.look(book.sheets.get(sheet)?.bands.look(row, column) ?? 0);
}

function cellsOf(book: Workbook, sheet = 'a'): SheetContent['cells'] {
    bytes(book);
    return book.content().sheets.find(({ id }) => id === sheet)?.cells ?? [];
}

function sheetContent(book: Workbook, sheet = 'a'): SheetContent | undefined {
    return book.content().sheets.find(({ id }) => id === sheet);
}

// The inverse passes the validators as it is.
function expectValid(ops: readonly Op[]): void {
    const text = JSON.stringify({ g: 1, now: 1, seed: 1, ops: [...ops] } satisfies Batch);
    expect(readBatch(text)).toEqual(JSON.parse(text));
}

// LAW 2 on one batch: the inverse restores the bytes, passes the validators, and its own inverse the bytes after. The
// model reads every place as the book does after the batch and after its inverse, which holds the bands canonical.
// Returns the inverse.
function expectLaw2(content: Book, ops: readonly Applied[]): Applied[] {
    const book = new Workbook(content);
    const before = bytes(book);
    const expected = modelAfter(modelOf(content), { now: content.now, seed: content.seed, ops: [...ops] });
    const inverse = applyOps(book, ops);
    if (typeof expected === 'string') throw new Error(`the model refused: ${expected}`);
    expectReads(book, expected);
    const after = bytes(book);
    expectValid(inverse);
    const again = applyOps(book, inverse);
    expect(bytes(book)).toBe(before);
    expectReads(book, modelOf(content));
    expectValid(again);
    applyOps(book, again);
    expect(bytes(book)).toBe(after);
    return inverse;
}

// Column 0 wears red on rows 0 to 4 and plain below; every other column is plain.
const RED_TOP = sheetOf('a', { looks: [{ bg: '#ff0000', bl: 1 }], bands: [0, 2, 0, 1, 5, 0, 1, 0] });

describe('engine/book/apply-format — what a cell format writes', () => {
    test('the named keys are set or cleared on every cell, and every other key of a look stays', () => {
        const book = new Workbook(bookOf(RED_TOP));
        applyOps(book, [format([[3, 0, 6, 1]], { it: 1, bdt: SIDE }, ['bg'])]);
        expect(lookAt(book, 2, 0)).toEqual({ bl: 1, bg: '#ff0000' });
        expect(lookAt(book, 3, 0)).toEqual({ bl: 1, it: 1, bdt: SIDE });
        expect(lookAt(book, 6, 0)).toEqual({ it: 1, bdt: SIDE });
        expect(lookAt(book, 6, 1)).toEqual({ it: 1, bdt: SIDE });
        expect(lookAt(book, 7, 1)).toEqual({});
        expect(lookAt(book, 3, 2)).toEqual({});
    });

    test('a whole column, a whole row and the whole sheet are written in the bands and runs they touch', () => {
        const book = new Workbook(bookOf(RED_TOP));
        const sheet = book.sheets.get('a');
        applyOps(book, [format([[0, 4, LAST_ROW, 4]], { fc: '#00ff00' })]);
        expect(sheet?.bands.weight()).toEqual({ runs: 3, bands: 4 });
        applyOps(book, [format([[9, 0, 9, LAST_COLUMN]], { un: 1 })]);
        expect(lookAt(book, 9, LAST_COLUMN)).toEqual({ un: 1 });
        expect(lookAt(book, 9, 4)).toEqual({ un: 1, fc: '#00ff00' });
        applyOps(book, [format([WHOLE], { ff: 'Inter' }, ['un'])]);
        expect(lookAt(book, 9, LAST_COLUMN)).toEqual({ ff: 'Inter' });
        expect(lookAt(book, 0, 0)).toEqual({ bl: 1, bg: '#ff0000', ff: 'Inter' });
        expect(lookAt(book, LAST_ROW, 4)).toEqual({ fc: '#00ff00', ff: 'Inter' });
        expect(sheet?.bands.weight()).toEqual({ runs: 5, bands: 4 });
    });

    test('overlapping rectangles in one op write each cell once', () => {
        const content = bookOf(RED_TOP);
        const inverse = expectLaw2(content, [
            format(
                [
                    [0, 0, 6, 1],
                    [4, 0, 9, 2],
                    [0, 0, 6, 1],
                ],
                { bg: '#0000ff' },
                ['bl'],
            ),
        ]);
        expect(inverse).toEqual([
            format([[0, 0, 4, 0]], { bl: 1 }),
            format([[0, 0, 4, 0]], { bg: '#ff0000' }),
            format(
                [
                    [5, 0, 6, 0],
                    [0, 1, 6, 1],
                    [7, 0, 9, 1],
                    [4, 2, 9, 2],
                ],
                undefined,
                ['bg'],
            ),
        ]);
    });

    test('a run-style key restyles every run of a rich cell in the ranges, and no other cell', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { s: MIXED_RUNS }],
                    [1, 0, { v: 'plain' }],
                    [5, 0, { s: MIXED_RUNS }],
                ],
            }),
        );
        const book = new Workbook(content);
        applyOps(book, [format([[0, 0, 1, 0]], { fs: 14, it: 1 }, ['bl'])]);
        expect(cellsOf(book)).toEqual([
            [
                0,
                0,
                {
                    s: [
                        { v: 'bold ', fs: 14, it: 1 },
                        { v: 'plain', fs: 14, it: 1 },
                    ],
                },
            ],
            [1, 0, { v: 'plain' }],
            [5, 0, { s: MIXED_RUNS }],
        ]);
    });

    test('a key that is not a run-style key leaves the runs as they are', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { s: MIXED_RUNS }]] })));
        const inverse = applyOps(book, [format([[0, 0, 0, 0]], { bg: '#ff0000', fa: '0.00' }, ['ht'])]);
        expect(cellsOf(book)).toEqual([[0, 0, { s: MIXED_RUNS }]]);
        expect(inverse.every((op) => op.kind === 'format')).toBe(true);
    });

    test('a link is set in the extras of every cell, keeping its runs, its mark and its value, and cleared so', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { s: PLAIN_RUNS }],
                    [1, 0, { v: 'typed', qp: 1 }],
                    [2, 0, { f: '=1+1' }],
                    [3, 0, { v: 4, link: OTHER }],
                    [9, 0, { v: 5, link: OTHER }],
                ],
            }),
        );
        const book = new Workbook(content);
        applyOps(book, [format([[0, 0, 4, 0]], { link: LINK, bl: 1 })]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { s: BOLD_RUNS, link: LINK }],
            [1, 0, { v: 'typed', link: LINK, qp: 1 }],
            [2, 0, { v: 2, f: '=1+1', link: LINK }],
            [3, 0, { v: 4, link: LINK }],
            [4, 0, { link: LINK }],
            [9, 0, { v: 5, link: OTHER }],
        ]);
        applyOps(book, [format([[0, 0, 9, 0]], undefined, ['link'])]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { s: BOLD_RUNS }],
            [1, 0, { v: 'typed', qp: 1 }],
            [2, 0, { v: 2, f: '=1+1' }],
            [3, 0, { v: 4 }],
            [9, 0, { v: 5 }],
        ]);
    });

    test('a format on a sheet the book does not hold is skipped alone', () => {
        const book = new Workbook(bookOf(RED_TOP));
        const before = bytes(book);
        expect(applyOps(book, [format([WHOLE], { bl: 1 }, undefined, 'gone')])).toEqual([]);
        expect(applyOps(book, [{ ...lines('rows', [[0, 3]], { size: 9 }), sheet: 'gone' }])).toEqual([]);
        expect(bytes(book)).toBe(before);
    });
});

describe('engine/book/apply-format — the inverse of a cell format', () => {
    test('one op per named key and per old value, over the cells whose value changed, coalesced', () => {
        const inverse = expectLaw2(bookOf(RED_TOP), [format([[0, 0, 9, 1]], { bg: '#00ff00', it: 1 })]);
        expect(inverse).toEqual([
            format([[0, 0, 9, 1]], undefined, ['it']),
            format([[0, 0, 4, 0]], { bg: '#ff0000' }),
            format(
                [
                    [5, 0, 9, 0],
                    [0, 1, 9, 1],
                ],
                undefined,
                ['bg'],
            ),
        ]);
    });

    test('a key the op does not name is not restored, and a cell that held the value set is not named', () => {
        const inverse = expectLaw2(bookOf(RED_TOP), [format([[0, 0, 9, 0]], { bl: 1 }, ['fc'])]);
        expect(inverse).toEqual([format([[5, 0, 9, 0]], undefined, ['bl'])]);
    });

    test('a clear of a key no cell holds has no inverse op, and a clear of a held key sets it back', () => {
        expect(expectLaw2(bookOf(RED_TOP), [format([[0, 1, 9, 3]], undefined, ['bl'])])).toEqual([]);
        expect(expectLaw2(bookOf(RED_TOP), [format([[2, 0, 9, 0]], undefined, ['bl'])])).toEqual([
            format([[2, 0, 4, 0]], { bl: 1 }),
        ]);
    });

    test('a format of one key over a uniform area undoes in one op whatever its size', () => {
        // 10,000 look spans, none of them bold.
        const bands: number[] = [];
        for (let column = 0; column < 100; column += 1) {
            bands.push(column, 100, ...Array.from({ length: 100 }, (_, run) => [run, 1 + ((run + column) % 2)]).flat());
        }
        const content = bookOf(sheetOf('a', { looks: [{ fc: '#111111' }, { fc: '#222222' }], bands }));
        const book = new Workbook(content);
        const before = bytes(book);
        const inverse = applyOps(book, [format([WHOLE], { bl: 1 })]);
        expect(inverse).toEqual([format([WHOLE], undefined, ['bl'])]);
        expect(lookAt(book, 50, 50)).toEqual({ bl: 1, fc: '#111111' });
        applyOps(book, inverse);
        expect(bytes(book)).toBe(before);
    });

    test('a format over 100,000 single cells of one look undoes in one op over one rectangle', () => {
        const ranges: Rect[] = [];
        for (let column = 0; column < 100; column += 1) {
            for (let row = 0; row < 1000; row += 1) ranges.push([row, column, row, column]);
        }
        const book = new Workbook(bookOf(sheetOf('a')));
        const inverse = applyOps(book, [format(ranges, { bg: '#ff0000' })]);
        expect(inverse).toEqual([format([[0, 0, 999, 99]], undefined, ['bg'])]);
        expect(book.sheets.get('a')?.bands.weight()).toEqual({ runs: 2, bands: 2 });
    });

    test('a border side is an old value like any other', () => {
        const other = { style: 2, color: '#ff0000' };
        const content = bookOf(sheetOf('a', { looks: [{ bdl: SIDE }, { bdl: other }], bands: [0, 2, 0, 1, 3, 2] }));
        const inverse = expectLaw2(content, [format([[0, 0, 5, 0]], { bdl: other })]);
        expect(inverse).toEqual([format([[0, 0, 2, 0]], { bdl: SIDE })]);
    });

    test('a rich cell whose runs agree with its look is restored by the format ops alone', () => {
        const content = bookOf(sheetOf('a', { cells: [[0, 0, { s: PLAIN_RUNS }]] }));
        const inverse = expectLaw2(content, [format([[0, 0, 2, 0]], { bl: 1 })]);
        expect(inverse).toEqual([format([[0, 0, 2, 0]], undefined, ['bl'])]);
    });

    test('a rich cell whose runs disagree on a named run-style key gets its old content in an input, last', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { s: MIXED_RUNS, link: OTHER }],
                    [1, 0, { s: PLAIN_RUNS }],
                    [0, 1, { s: BOLD_RUNS, qp: 1 }],
                ],
            }),
        );
        const inverse = expectLaw2(content, [format([[0, 0, 1, 1]], { bl: 1, link: LINK })]);
        const input: InputOp = {
            kind: 'input',
            sheet: 'a',
            cells: [
                [0, 0, { s: MIXED_RUNS, link: OTHER }],
                [0, 1, { s: BOLD_RUNS, qp: 1 }],
            ],
        };
        expect(inverse).toEqual([
            format([[0, 0, 1, 1]], undefined, ['bl']),
            format([[0, 0, 1, 1]], undefined, ['link']),
            format([[0, 0, 0, 0]], { link: OTHER }),
            input,
        ]);
    });

    test('a link inverse clears the ranges, then sets each old link back over the cells that held it', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { v: 1, link: OTHER }],
                    [1, 0, { v: 2, link: OTHER }],
                    [3, 0, { v: 3, link: LINK }],
                    [0, 1, { v: 4, link: OTHER }],
                    [1, 1, { v: 5, link: OTHER }],
                ],
            }),
        );
        expect(expectLaw2(content, [format([[0, 0, 5, 1]], { link: LINK })])).toEqual([
            format([[0, 0, 5, 1]], undefined, ['link']),
            format([[0, 0, 1, 1]], { link: OTHER }),
            format([[3, 0, 3, 0]], { link: LINK }),
        ]);
        expect(expectLaw2(content, [format([[1, 0, 5, 1]], undefined, ['link'])])).toEqual([
            format([[1, 0, 1, 1]], { link: OTHER }),
            format([[3, 0, 3, 0]], { link: LINK }),
        ]);
    });

    test('LAW 2 over a format after an input on rich cells and an input after a format', () => {
        const content = bookOf(RED_TOP, sheetOf('b', { fields: { name: 'b', order: 'a1' } }));
        const rich: InputOp = {
            kind: 'input',
            sheet: 'a',
            cells: [
                [0, 0, { s: MIXED_RUNS }],
                [2, 0, { s: PLAIN_RUNS, qp: 1 }],
                [3, 1, { v: 'x', link: OTHER }],
            ],
        };
        expectLaw2(content, [rich, format([[0, 0, 3, 1]], { bl: 1, fc: '#00ff00', link: LINK }, ['bg'])]);
        expectLaw2(content, [format([[0, 0, 3, 1]], { it: 1, link: LINK }, ['bl']), rich]);
        expectLaw2(content, [rich, format([[0, 0, 3, 1]], { it: 1 }), rich, format([[2, 0, 2, 0]], undefined, ['it'])]);
        expectLaw2(content, [
            format([[0, 0, 9, 9]], { bl: 1 }),
            lines('rows', [[0, 4]], { size: 40 }),
            format([[0, 0, 9, 9]], undefined, ['bl', 'link']),
        ]);
    });
});

describe('engine/book/apply-format — LAW 3: an inverse restores only the keys its op named', () => {
    // A writes, B writes after it, and A's inverse lands over B.
    function afterUndo(content: Book, a: FormatOp, b: FormatOp): Workbook {
        const book = new Workbook(content);
        const inverse = applyOps(book, [a]);
        applyOps(book, [b]);
        applyOps(book, inverse);
        return book;
    }

    test('A sets bl on R, B sets it on R′, A’s inverse lands: every cell of R ∩ R′ keeps it', () => {
        const book = afterUndo(bookOf(RED_TOP), format([[0, 0, 5, 5]], { bl: 1 }), format([[3, 3, 9, 9]], { it: 1 }));
        for (let row = 3; row <= 5; row += 1) {
            for (let column = 3; column <= 5; column += 1) expect(lookAt(book, row, column)).toEqual({ it: 1 });
        }
        expect(lookAt(book, 0, 0)).toEqual({ bl: 1, bg: '#ff0000' });
        expect(lookAt(book, 1, 1)).toEqual({});
        expect(lookAt(book, 9, 9)).toEqual({ it: 1 });
    });

    test('A sets bg over cells of another color, B clears their bl, A’s inverse puts the color back and not bl', () => {
        const book = afterUndo(
            bookOf(RED_TOP),
            format([[0, 0, 5, 5]], { bg: '#00ff00' }),
            format([[3, 0, 9, 9]], undefined, ['bl']),
        );
        expect([lookAt(book, 2, 0), lookAt(book, 3, 0), lookAt(book, 5, 0), lookAt(book, 4, 4)]).toEqual([
            { bl: 1, bg: '#ff0000' },
            { bg: '#ff0000' },
            {},
            {},
        ]);
    });

    test('a format that clears every other key keeps a peer’s key outside its own', () => {
        const rest = LOOK_KEYS.filter((key) => key !== 'bl' && key !== 'it');
        const book = afterUndo(
            bookOf(RED_TOP),
            format([[0, 0, 5, 5]], { bl: 1 }, rest),
            format([[3, 3, 9, 9]], { it: 1 }),
        );
        expect(lookAt(book, 4, 4)).toEqual({ it: 1 });
        expect(lookAt(book, 2, 0)).toEqual({ bl: 1, bg: '#ff0000' });
    });

    test('A sets a link, B sets bl over it, A’s inverse lands: bl stays; and the other way round', () => {
        const content = bookOf(RED_TOP);
        const linked = afterUndo(content, format([[0, 0, 5, 5]], { link: LINK }), format([[3, 3, 9, 9]], { bl: 1 }));
        expect(lookAt(linked, 4, 4)).toEqual({ bl: 1 });
        expect(cellsOf(linked)).toEqual([]);
        const bold = afterUndo(content, format([[0, 0, 5, 5]], { bl: 1 }), format([[3, 3, 9, 9]], { link: LINK }));
        expect(lookAt(bold, 4, 4)).toEqual({});
        expect(cellsOf(bold).length).toBe(49);
    });

    test('A sets size on rows, B hides some of them, A’s inverse lands: they stay hidden; and the other way round', () => {
        const content = bookOf(sheetOf('a', { rows: [[[0, 1], { custom: 1 }]] }));
        const sized = afterUndo(content, lines('rows', [[0, 5]], { size: 30 }), lines('rows', [[3, 9]], { hidden: 1 }));
        expect(sheetContent(sized)?.rows).toEqual([
            [[0, 1], { custom: 1 }],
            [[3, 9], { hidden: 1 }],
        ]);
        const hidden = afterUndo(
            content,
            lines('rows', [[0, 5]], { hidden: 1 }),
            lines('rows', [[3, 9]], { size: 30 }),
        );
        expect(sheetContent(hidden)?.rows).toEqual([
            [[0, 1], { custom: 1 }],
            [[3, 9], { size: 30 }],
        ]);
    });

    test('the same on columns, a clear against a set', () => {
        const content = bookOf(sheetOf('a', { columns: [[[0, 9], { size: 80, custom: 1 }]] }));
        const book = afterUndo(
            content,
            lines('columns', [[0, 5]], undefined, ['size']),
            lines('columns', [[3, 9]], undefined, ['custom']),
        );
        expect(sheetContent(book)?.columns).toEqual([
            [[0, 2], { size: 80, custom: 1 }],
            [[3, 9], { size: 80 }],
        ]);
    });
});

describe('engine/book/apply-format — a line format', () => {
    test('the named keys are set or cleared on every line of the spans, and the others stay', () => {
        const content = bookOf(
            sheetOf('a', {
                rows: [
                    [[3, 4], { size: 30, custom: 1 }],
                    [[5, 5], { hidden: 1 }],
                ],
            }),
        );
        const book = new Workbook(content);
        applyOps(book, [
            lines(
                'rows',
                [
                    [2, 5],
                    [4, 6],
                ],
                { size: 50 },
                ['custom'],
            ),
        ]);
        expect(sheetContent(book)?.rows).toEqual([
            [[2, 4], { size: 50 }],
            [[5, 5], { size: 50, hidden: 1 }],
            [[6, 6], { size: 50 }],
        ]);
    });

    test('its inverse is one op per named key and per old value, over the runs of lines that held it', () => {
        const content = bookOf(
            sheetOf('a', {
                rows: [
                    [[3, 4], { size: 30, custom: 1 }],
                    [[5, 5], { hidden: 1 }],
                    [[6, 7], { size: 30 }],
                    [[9, 9], { size: 50 }],
                ],
            }),
        );
        const inverse = expectLaw2(content, [lines('rows', [[2, 9]], { size: 50, hidden: 1 })]);
        expect(inverse).toEqual([
            lines(
                'rows',
                [
                    [2, 2],
                    [5, 5],
                    [8, 8],
                ],
                undefined,
                ['size'],
            ),
            lines(
                'rows',
                [
                    [3, 4],
                    [6, 7],
                ],
                { size: 30 },
            ),
            lines(
                'rows',
                [
                    [2, 4],
                    [6, 9],
                ],
                undefined,
                ['hidden'],
            ),
        ]);
    });

    test('a line format changes no cell, look or link', () => {
        const content = bookOf({ ...RED_TOP, cells: [[0, 0, { v: 1, link: LINK }]] });
        const inverse = expectLaw2(content, [lines('columns', [[0, LAST_COLUMN]], { size: 12, custom: 1 })]);
        expect(inverse).toEqual([
            lines('columns', [[0, LAST_COLUMN]], undefined, ['size']),
            lines('columns', [[0, LAST_COLUMN]], undefined, ['custom']),
        ]);
    });
});

describe('engine/book/apply-format — two peers formatting one range (the falsifier’s cases)', () => {
    const REST = LOOK_KEYS.filter((key) => key !== 'bl');

    test('3: a format that clears the rest against a single key: the order decides, each order keeps LAW 2', () => {
        const paste = format([[0, 0, 0, 1]], { bl: 1 }, REST);
        const peer = format([[0, 1, 0, 1]], { bg: '#ff0000' });
        const content = bookOf(sheetOf('a'));
        const first = new Workbook(content);
        applyOps(first, [paste, peer]);
        expect(lookAt(first, 0, 1)).toEqual({ bl: 1, bg: '#ff0000' });
        const second = new Workbook(content);
        applyOps(second, [peer, paste]);
        expect(lookAt(second, 0, 1)).toEqual({ bl: 1 });
        expectLaw2(content, [paste, peer]);
        expectLaw2(content, [peer, paste]);
    });

    test('8: a clear of every look over a block whose cells each wear their own has an inverse per old value', () => {
        for (const side of [10, 32, 100]) {
            const looks: CellAttrs[] = [];
            const bands: number[] = [];
            for (let column = 0; column < side; column += 1) {
                bands.push(column, side);
                for (let row = 0; row < side; row += 1) {
                    bands.push(row, looks.push({ bl: 1, bg: `#${((row * 131 + column) % 4096).toString(16)}` }));
                }
            }
            bands.push(side, 0);
            const content = bookOf(sheetOf('a', { looks, bands }));
            const clear = format([[0, 0, side - 1, side - 1]], undefined, [...LOOK_KEYS]);
            const inverse = side < 100 ? expectLaw2(content, [clear]) : applyOps(new Workbook(content), [clear]);
            const values = new Set(looks.map(({ bg }) => bg));
            // One op for bl over one rectangle, and one per old color over its cells, which touch no other of theirs.
            expect(inverse.length).toBe(1 + values.size);
            expect(inverse[0]).toEqual(format([[0, 0, side - 1, side - 1]], { bl: 1 }));
            const rectangles = inverse.reduce((sum, op) => sum + ('ranges' in op ? op.ranges.length : 0), 0);
            expect(rectangles).toBe(1 + side * side);
        }
    });

    test('9: the undo of a paste after a peer set a key the paste cleared names that key in an op of its own', () => {
        const content = bookOf(sheetOf('a', { looks: [{ it: 1, bg: '#0000ff' }], bands: [0, 2, 0, 1, 1, 0, 1, 0] }));
        const paste = format([[0, 0, 0, 1]], { bl: 1 }, REST);
        const peer = format([[0, 0, 0, 1]], { bg: '#ff0000' });
        const book = new Workbook(content);
        const inverse = applyOps(book, [paste]);
        applyOps(book, [peer]);
        // Applied whole, the undo puts back the color the paste cleared over the peer's; where the paste cleared a
        // color no cell held, it says nothing of the color, and the peer's stays.
        const whole = new Workbook(content);
        applyOps(whole, [paste, peer]);
        applyOps(whole, inverse);
        expect([lookAt(whole, 0, 0), lookAt(whole, 0, 1)]).toEqual([{ it: 1, bg: '#0000ff' }, { bg: '#ff0000' }]);
        // Every key has its own op, so a guard that drops the ops of the keys a peer changed since keeps the peer's.
        const named = (op: Applied) =>
            op.kind === 'format' ? [...Object.keys(op.set ?? {}), ...(op.clear ?? [])] : [];
        expect(inverse.map(named)).toEqual([['bl'], ['it'], ['bg']]);
        applyOps(
            book,
            inverse.filter((op) => !named(op).includes('bg')),
        );
        expect([lookAt(book, 0, 0), lookAt(book, 0, 1)]).toEqual([{ it: 1, bg: '#ff0000' }, { bg: '#ff0000' }]);
    });
});

describe('engine/book/apply-format — the look sweep', () => {
    test('looks a format wore and took off leave the table at the sweep, and the bands stay canonical', () => {
        const content = bookOf(RED_TOP);
        const book = new Workbook(content);
        const ops = Array.from({ length: 80 }, (_, at) => format([[at, 3, at, 3]], { fc: `#0000${at + 10}` }));
        const inverse = applyOps(book, [...ops, format([[0, 3, 99, 3]], undefined, ['fc'])]);
        expect(book.looks.size).toBe(2);
        expectReads(book, modelOf(content));
        expect(inverse.length).toBe(160);
        applyOps(book, inverse);
        expectReads(book, modelOf(content));
    });
});
