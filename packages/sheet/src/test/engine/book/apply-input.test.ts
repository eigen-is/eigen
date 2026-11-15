import { describe, expect, test } from 'bun:test';
import type { Batch, CellContent, InputOp, Op, RecordOp, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import { inputOfBlocks } from '../../../engine/book/apply-input';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { bytes } from './bytes';
import { expectReads, modelAfter, modelOf } from './model';

const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
const RICH = [
    { v: 'bold ', bl: 1 },
    { v: 'and red', fc: '#ff0000' },
] as const;
const KEPT = "='[1]N'!R1C1+1";
const SPAN = "=SUM('N:M'!R1C1)";
// A sheet id as long as an id may be, so a formula bound to it grows.
const LONG_ID = 'b'.repeat(60);

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000.5, seed: 7, sheets };
}

function input(part: Omit<InputOp, 'kind' | 'sheet'>, sheet = 'a'): InputOp {
    return { kind: 'input', sheet, ...part };
}

function rename(sheet: string, name: string): RecordOp {
    return { kind: 'record', sheet, type: 'sheet', id: sheet, set: { name } };
}

// The inverse passes the validators as it is.
function expectValid(ops: readonly Op[]): void {
    const text = JSON.stringify({ g: 1, now: 1, seed: 1, ops: [...ops] } satisfies Batch);
    expect(readBatch(text)).toEqual(JSON.parse(text));
}

// LAW 2 on one batch: the inverse restores the bytes, passes the validators, and its own inverse the bytes after. The
// model reads every place as the book does after the batch. Returns the inverse.
function expectLaw2(content: Book, ops: readonly Op[]): Op[] {
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

function cellsOf(book: Workbook, sheet = 'a'): SheetContent['cells'] {
    bytes(book);
    return book.content().sheets.find(({ id }) => id === sheet)?.cells ?? [];
}

describe('engine/book/apply-input — what an input writes', () => {
    test('cells take values, errors, formulas, rich runs, links and the quote mark', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { v: 2 }]] })));
        applyOps(book, [
            input({
                cells: [
                    [1, 0, { v: 'text', qp: 1 }],
                    [2, 0, { v: '#N/A', e: 1 }],
                    [3, 0, { f: '=R[-3]C*2' }],
                    [4, 0, { s: [...RICH], link: LINK }],
                    [5, 0, { link: LINK }],
                    [6, 0, { v: false }],
                ],
            }),
        ]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { v: 2 }],
            [1, 0, { v: 'text', qp: 1 }],
            [2, 0, { v: '#N/A', e: 1 }],
            [3, 0, { v: 4, f: '=R[-3]C*2' }],
            [4, 0, { s: [...RICH], link: LINK }],
            [5, 0, { link: LINK }],
            [6, 0, { v: false }],
        ]);
        // The text of a rich cell is the value formulas read.
        applyOps(book, [input({ cells: [[7, 0, { f: '=LEN(R[-3]C)' }]] })]);
        bytes(book);
        expect(book.engine.valueOf('a', 7, 0)).toBe(12);
    });

    test('a run of null empties its rectangle, links and marks included, and leaves the rest', () => {
        const cells: SheetContent['cells'] = [
            [0, 0, { v: 1 }],
            [1, 0, { f: '=R[-1]C+1' }],
            [2, 0, { link: LINK }],
            [3, 0, { s: [...RICH] }],
            [4, 0, { v: 'x', qp: 1 }],
            [1, 1, { v: 2 }],
        ];
        const book = new Workbook(bookOf(sheetOf('a', { cells })));
        applyOps(book, [input({ runs: [[[1, 0, 3, 0], null]] })]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { v: 1 }],
            [4, 0, { v: 'x', qp: 1 }],
            [1, 1, { v: 2 }],
        ]);
        expect(expectLaw2(bookOf(sheetOf('a', { cells })), [input({ runs: [[[1, 0, 3, 0], null]] })])).toEqual([
            input({ cells: cells.slice(1, 4) }),
        ]);
    });

    test('a formula run is one stored key in every cell, and a value run that value in every cell', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { v: 3 }]] })));
        applyOps(book, [
            input({
                runs: [
                    [[1, 0, 3, 1], { f: '=R1C1+1' }],
                    [[0, 2, 1, 2], { s: [...RICH], qp: 1 }],
                ],
            }),
        ]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { v: 3 }],
            [1, 0, { v: 4, f: '=R1C1+1' }],
            [2, 0, { v: 4, f: '=R1C1+1' }],
            [3, 0, { v: 4, f: '=R1C1+1' }],
            [1, 1, { v: 4, f: '=R1C1+1' }],
            [2, 1, { v: 4, f: '=R1C1+1' }],
            [3, 1, { v: 4, f: '=R1C1+1' }],
            [0, 2, { s: [...RICH], qp: 1 }],
            [1, 2, { s: [...RICH], qp: 1 }],
        ]);
    });

    test('an input replaces the link and the mark of a cell, and keeps its look and records', () => {
        const content = bookOf(
            sheetOf('a', {
                cells: [
                    [0, 0, { v: 'x', link: LINK, qp: 1 }],
                    [1, 0, { s: [...RICH], link: LINK }],
                ],
                looks: [{ bl: 1 }],
                bands: [0, 1, 0, 1],
                records: { comment: { c: { row: 0, column: 0 } } },
            }),
        );
        const book = new Workbook(content);
        const inverse = applyOps(book, [
            input({
                cells: [
                    [0, 0, { v: 'y' }],
                    [1, 0, { v: 1, qp: 1 }],
                ],
            }),
        ]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { v: 'y' }],
            [1, 0, { v: 1, qp: 1 }],
        ]);
        expect(book.content().sheets[0]).toMatchObject({ looks: [{ bl: 1 }], bands: [0, 1, 0, 1] });
        expect(book.content().sheets[0].records).toEqual({ comment: { c: { row: 0, column: 0 } } });
        expect(inverse).toEqual([
            input({
                cells: [
                    [0, 0, { v: 'x', link: LINK, qp: 1 }],
                    [1, 0, { s: [...RICH], link: LINK }],
                ],
            }),
        ]);
        expectLaw2(content, [input({ runs: [[[0, 0, 1, 0], { v: 2 }]] })]);
    });

    test('an input on a sheet the book does not hold is skipped alone', () => {
        const content = bookOf(sheetOf('a'));
        const book = new Workbook(content);
        const before = bytes(book);
        const ops = [input({ cells: [[0, 0, { v: 1 }]] }, 'gone'), input({ cells: [[1, 0, { v: 2 }]] })];
        expect(applyOps(book, ops)).toEqual([input({ cells: [[1, 0, null]] })]);
        expect(cellsOf(book)).toEqual([[1, 0, { v: 2 }]]);
        applyOps(book, [input({ cells: [[1, 0, null]] })]);
        expect(bytes(book)).toBe(before);
    });
});

describe('engine/book/apply-input — a value given beside a formula', () => {
    test('a formula this build cannot evaluate keeps the value it comes with, and its inverse carries it', () => {
        const content = bookOf(sheetOf('a'), sheetOf('n', { fields: { name: 'N', order: 'a1' } }));
        const book = new Workbook(content);
        applyOps(book, [
            input({
                cells: [
                    [0, 0, { f: KEPT, v: 42 }],
                    [1, 0, { f: SPAN, v: '#N/A', e: 1 }],
                    [2, 0, { f: KEPT }],
                    [3, 0, { f: '=R1C1+1', v: 99 }],
                ],
            }),
        ]);
        expect(cellsOf(book)).toEqual([
            [0, 0, { v: 42, f: KEPT }],
            [1, 0, { v: '#N/A', e: 1, f: SPAN }],
            [2, 0, { v: '#REF!', e: 1, f: KEPT }],
            [3, 0, { v: 43, f: '=R1C1+1' }],
        ]);
        // A given value rides beside its formula, a computed one does not.
        expect(applyOps(book, [input({ runs: [[[0, 0, 3, 0], null]] })])).toEqual([
            input({
                cells: [
                    [0, 0, { v: 42, f: KEPT }],
                    [1, 0, { v: '#N/A', e: 1, f: SPAN }],
                    [2, 0, { v: '#REF!', e: 1, f: KEPT }],
                    [3, 0, { f: '=R1C1+1' }],
                ],
            }),
        ]);
    });

    test('a formula given no value, not yet computed, has no value to give back', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { v: 5 }]] })));
        applyOps(book, [input({ cells: [[0, 0, { f: KEPT }]] })]);
        const inverse = applyOps(book, [input({ cells: [[0, 0, { v: 1 }]] })]);
        expect(inverse).toEqual([input({ cells: [[0, 0, { f: KEPT }]] })]);
        applyOps(book, inverse);
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toMatchObject({ text: '#REF!' });
    });

    test('LAW 2 over given values and fills of them', () => {
        const content = bookOf(sheetOf('a', { cells: [[0, 0, { f: KEPT, v: 7 }]] }));
        expectLaw2(content, [
            input({ runs: [[[0, 0, 4, 1], { f: KEPT, v: 3 }]], cells: [[9, 0, { f: SPAN, v: 'x' }]] }),
            input({ cells: [[2, 1, { f: KEPT, v: 4 }]] }),
        ]);
    });
});

describe('engine/book/apply-input — the inverse groups the old content into runs', () => {
    const grouped = (cells: SheetContent['cells'], runs: InputOp['runs'], list?: InputOp['cells']) => {
        const content = bookOf(sheetOf('a', { cells }));
        return expectLaw2(content, [input({ runs, cells: list })]);
    };

    test('a rectangle that was empty is one null run', () => {
        expect(grouped([[0, 9, { v: 1 }]], [[[0, 0, 9_999, 3], { f: '=RC[-1]*R1C2' }]])).toEqual([
            input({ runs: [[[0, 0, 9_999, 3], null]] }),
        ]);
    });

    test('a rectangle of one stored key, or of one value, is one run', () => {
        const filled = (content: CellContent): SheetContent['cells'] =>
            [0, 1].flatMap((column) => [0, 1, 2].map((row) => [row, column, content] as const));
        expect(grouped(filled({ f: '=R1C3+1' }), [[[0, 0, 2, 1], null]])).toEqual([
            input({ runs: [[[0, 0, 2, 1], { f: '=R1C3+1' }]] }),
        ]);
        expect(grouped(filled({ v: 'x', link: LINK }), [[[0, 0, 2, 1], { v: 1 }]])).toEqual([
            input({ runs: [[[0, 0, 2, 1], { v: 'x', link: LINK }]] }),
        ]);
        expect(grouped(filled({ v: '#N/A', e: 1 }), [[[0, 0, 2, 1], { v: 1 }]])).toEqual([
            input({ runs: [[[0, 0, 2, 1], { v: '#N/A', e: 1 }]] }),
        ]);
        expect(grouped(filled({ f: KEPT, v: 4 }), [[[0, 0, 2, 1], null]])).toEqual([
            input({ runs: [[[0, 0, 2, 1], { v: 4, f: KEPT }]] }),
        ]);
    });

    test('runs of equal content down a column join across columns that hold them on the same rows', () => {
        const cells: SheetContent['cells'] = [
            [0, 0, { v: 7 }],
            [1, 0, { v: 7 }],
            [3, 0, { v: 8 }],
            [0, 1, { v: 7 }],
            [1, 1, { v: 7 }],
            [3, 1, { v: 9 }],
            [0, 2, { v: 7 }],
        ];
        expect(grouped(cells, [[[0, 0, 4, 2], null]])).toEqual([
            input({
                runs: [
                    [[0, 0, 1, 1], { v: 7 }],
                    [[2, 0, 2, 1], null],
                    [[4, 0, 4, 1], null],
                    [[1, 2, 4, 2], null],
                ],
                cells: [
                    [3, 0, { v: 8 }],
                    [3, 1, { v: 9 }],
                    [0, 2, { v: 7 }],
                ],
            }),
        ]);
    });

    test('content that differs only by its link, its mark, its runs or its given value is not joined', () => {
        const other = { type: 'cellrange', address: 'A1:B2' } as const;
        const cells: SheetContent['cells'] = [
            [0, 0, { v: 'x' }],
            [1, 0, { v: 'x', link: LINK }],
            [2, 0, { v: 'x', link: other }],
            [3, 0, { v: 'x', link: other, qp: 1 }],
            [4, 0, { s: [{ v: 'x' }] }],
            [5, 0, { s: [{ v: 'x', bl: 1 }] }],
            [6, 0, { f: KEPT, v: 1 }],
            [7, 0, { f: KEPT, v: 2 }],
            [8, 0, { f: '=R1C2' }],
            [9, 0, { f: '=R1C2' }],
        ];
        const [inverse] = grouped(cells, [[[0, 0, 9, 0], null]]);
        expect(inverse).toEqual(
            input({
                runs: [[[8, 0, 9, 0], { f: '=R1C2' }]],
                cells: cells.slice(0, 8),
            }),
        );
    });

    test('the cells of the op outside its runs are listed in column order with the cells of the runs', () => {
        const cells: SheetContent['cells'] = [
            [0, 0, { v: 1 }],
            [5, 0, { v: 2 }],
            [0, 4, { v: 3 }],
        ];
        expect(
            grouped(
                cells,
                [
                    [[0, 0, 0, 0], { v: 9 }],
                    [[0, 3, 1, 3], { v: 9 }],
                ],
                [
                    [5, 0, null],
                    [9, 1, { v: 5 }],
                ],
            ),
        ).toEqual([
            input({
                runs: [[[0, 3, 1, 3], null]],
                cells: [
                    [0, 0, { v: 1 }],
                    [5, 0, { v: 2 }],
                    [9, 1, null],
                ],
            }),
        ]);
    });

    test('the cells of the op are not joined into runs, and an empty one is null', () => {
        expect(
            grouped([[1, 0, { v: 1 }]], undefined, [
                [0, 0, { v: 1 }],
                [1, 0, { v: 2 }],
                [2, 0, { v: 3 }],
            ]),
        ).toEqual([
            input({
                cells: [
                    [0, 0, null],
                    [1, 0, { v: 1 }],
                    [2, 0, null],
                ],
            }),
        ]);
    });
});

describe('engine/book/apply-input — the book keeps what the engine reads back', () => {
    test('a formula typed with the name of a held sheet is stored bound, and undo and redo keep the bound text', () => {
        const content = bookOf(
            sheetOf('a'),
            sheetOf('b', { fields: { name: 'Data', order: 'a1' }, cells: [[0, 0, { v: 5 }]] }),
        );
        const book = new Workbook(content);
        applyOps(book, [input({ cells: [[0, 0, { f: "='Data'!R1C1+1" }]] })]);
        expect(cellsOf(book)).toEqual([[0, 0, { v: 6, f: '=[b]!R1C1+1' }]]);
        const inverse = applyOps(book, [input({ cells: [[0, 0, { v: 1 }]] })]);
        expect(inverse).toEqual([input({ cells: [[0, 0, { f: '=[b]!R1C1+1' }]] })]);
        const redo = applyOps(book, inverse);
        expect(cellsOf(book)).toEqual([[0, 0, { v: 6, f: '=[b]!R1C1+1' }]]);
        applyOps(book, redo);
        expect(cellsOf(book)).toEqual([[0, 0, { v: 1 }]]);
        expectLaw2(content, [input({ runs: [[[0, 0, 3, 0], { f: "='Data'!R1C1+1" }]] }), rename('b', 'Other')]);
    });

    test('a formula too long to store bound holds #REF! in place of the name, and undo brings that back', () => {
        const long = `="${'a'.repeat(131_010)}"&'N'!R1C1`;
        const content = bookOf(sheetOf('a'), sheetOf(LONG_ID, { fields: { name: 'N', order: 'a1' } }));
        const book = new Workbook(content);
        applyOps(book, [input({ cells: [[0, 0, { f: long }]] })]);
        const stored = `="${'a'.repeat(131_010)}"&#REF!`;
        expect(book.engine.formulaOf('a', 0, 0)).toBe(stored);
        expect(applyOps(book, [input({ cells: [[0, 0, null]] })])).toEqual([input({ cells: [[0, 0, { f: stored }]] })]);
        expectLaw2(content, [input({ cells: [[0, 0, { f: long }]] })]);
    });
});

describe('engine/book/apply-input — a rename that binds formulas typed with the new name', () => {
    const typed = "='Later'!R1C1+1";
    const content = bookOf(
        sheetOf('a', {
            cells: [
                [0, 0, { f: typed }],
                [1, 0, { f: typed, link: LINK }],
                [2, 0, { f: typed }],
                [3, 0, { f: `${typed}+'[1]x'!R1C1`, v: 4 }],
                [0, 1, { f: typed }],
                [1, 1, { f: typed }],
                [2, 1, { f: typed, qp: 1 }],
            ],
        }),
        sheetOf('b', { fields: { name: 'B', order: 'a1' }, cells: [[0, 0, { v: 5 }]] }),
    );

    test('its inverse is the rename back first, then the old text of every formula it bound', () => {
        const book = new Workbook(content);
        const inverse = applyOps(book, [rename('b', 'Later')]);
        expect(book.engine.formulaOf('a', 0, 0)).toBe('=[b]!R1C1+1');
        expect(inverse).toEqual([
            rename('b', 'B'),
            input({
                runs: [[[0, 1, 1, 1], { f: typed }]],
                cells: [
                    [0, 0, { f: typed }],
                    [1, 0, { f: typed, link: LINK }],
                    [2, 0, { f: typed }],
                    [3, 0, { v: 4, f: `${typed}+'[1]x'!R1C1` }],
                    [2, 1, { f: typed, qp: 1 }],
                ],
            }),
        ]);
        expectLaw2(content, [rename('b', 'Later')]);
    });

    test('a rename back to a name typed after the rename binds again, and takes that back too', () => {
        const ops: Op[] = [
            rename('b', 'Later'),
            input({ cells: [[5, 5, { f: "='B'!R1C1" }]] }),
            rename('b', 'B'),
            input({ cells: [[6, 5, { f: "='Later'!R1C1" }]] }),
        ];
        expectLaw2(content, ops);
    });

    test('a refused batch after the rename takes the bound formulas back', () => {
        const book = new Workbook({
            ...content,
            sheets: [{ ...content.sheets[0], records: { merge: { m: { rect: [5, 5, 6, 6] } } } }, content.sheets[1]],
        });
        const before = bytes(book);
        const overlap: RecordOp = {
            kind: 'record',
            sheet: 'a',
            type: 'merge',
            id: 'n',
            set: { rect: [6, 6, 7, 7] },
            whole: 1,
        };
        expect(() => applyOps(book, [rename('b', 'Later'), overlap])).toThrow();
        expect(bytes(book)).toBe(before);
    });
});

describe('engine/book/apply-input — sizes', () => {
    test('a fill of one key down a column of 1,000,000 empty cells has one null run for its inverse', () => {
        const content = bookOf(sheetOf('a', { cells: [[0, 1, { v: 2 }]] }));
        const book = new Workbook(content);
        const rect: Rect = [1, 3, 1_000_000, 3];
        const inverse = applyOps(book, [input({ runs: [[rect, { f: '=RC[-1]*R1C2' }]] })]);
        expect(inverse).toEqual([input({ runs: [[rect, null]] })]);
        expect(book.engine.formulaOf('a', 1_000_000, 3)).toBe('=RC[-1]*R1C2');
        // Over the filled block, the inverse is one run of the key.
        expect(applyOps(book, [input({ runs: [[rect, null]] })])).toEqual([
            input({ runs: [[rect, { f: '=RC[-1]*R1C2' }]] }),
        ]);
        expect(book.engine.columnLength('a', 3)).toBe(0);
    });

    test('an op of 50,000 runs and 100,000 cells beside them reads and writes each place once', () => {
        const book = new Workbook(bookOf(sheetOf('a')));
        const runs = Array.from({ length: 50_000 }, (_, at): [Rect, CellContent] => {
            const [top, column] = [(at % 1_000) * 3, Math.floor(at / 1_000) * 2];
            return [[top, column, top + 1, column], { v: 1 }];
        });
        const cells = Array.from({ length: 100_000 }, (_, at): [number, number, CellContent] => {
            const [row, column] = [at % 1_000, Math.floor(at / 1_000)];
            return [column % 2 === 0 ? row * 3 + 2 : row, column, { v: 2 }];
        });
        const started = performance.now();
        const [inverse] = applyOps(book, [input({ runs, cells })]);
        expect(performance.now() - started).toBeLessThan(3_000);
        expect(inverse).toEqual(
            input({
                runs: runs.map(([rect]) => [rect, null]),
                cells: cells.map(([row, column]) => [row, column, null]),
            }),
        );
    });
});

describe('engine/book/apply-input — what blocks hold', () => {
    const content = () =>
        bookOf(
            sheetOf('a', {
                cells: [
                    [2, 0, { v: 1 }],
                    [3, 0, { v: 1 }],
                    [2, 1, { v: 1 }],
                    [3, 1, { v: 1 }],
                    [9, 1, { f: '=R3C1+1' }],
                    [4, 3, { link: LINK }],
                    [5, 3, { v: 'q', qp: 1 }],
                ],
            }),
        );

    test('lists the cells the blocks hold and no empty one, runs of equal content joined', () => {
        const blocks: Rect[] = [
            [0, 0, 20, 1],
            [4, 3, 5, 9],
        ];
        expect(inputOfBlocks(new Workbook(content()), 'a', blocks)).toEqual(
            input({
                runs: [[[2, 0, 3, 1], { v: 1 }]],
                cells: [
                    [9, 1, { f: '=R3C1+1' }],
                    [4, 3, { link: LINK }],
                    [5, 3, { v: 'q', qp: 1 }],
                ],
            }),
        );
    });

    test('is none for blocks that hold nothing, for no block and for a sheet the book does not hold', () => {
        const book = new Workbook(content());
        expect(inputOfBlocks(book, 'a', [[0, 4, 50, 9]])).toBeUndefined();
        expect(inputOfBlocks(book, 'a', [])).toBeUndefined();
        expect(inputOfBlocks(book, 'nosheet', [[0, 0, 9, 9]])).toBeUndefined();
    });

    test('written onto the blocks once they are empty, gives back what they held', () => {
        const book = new Workbook(content());
        const before = bytes(book);
        const blocks: Rect[] = [
            [0, 0, 3, 0],
            [9, 1, 9, 1],
            [4, 2, 6, 3],
        ];
        const held = inputOfBlocks(book, 'a', blocks);
        applyOps(book, [input({ runs: blocks.map((rect) => [rect, null]) })]);
        if (held) applyOps(book, [held]);
        expect(bytes(book)).toBe(before);
    });
});
