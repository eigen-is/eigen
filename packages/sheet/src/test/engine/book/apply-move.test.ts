import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type {
    Batch,
    CellAttrs,
    FormatOp,
    InputOp,
    LinesOp,
    MoveOp,
    Op,
    Rect,
    SheetContent,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { CellLink } from '@workspace/lib/sheets/types';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import {
    batchOf,
    randomBookContent,
    randomFormatOp,
    randomInputOp,
    randomLandingReaderOp,
    randomMoveOp,
    randomRecordOp,
    randomSheetOp,
} from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { expectReads, modelAfter, modelOf } from './model';
import { formulaRule } from './records-fixtures';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const OTHER: CellLink = { type: 'cellrange', address: 'A1:B2' };
const RICH = [
    { v: 'bold ', bl: 1 },
    { v: 'red', fc: '#ff0000' },
] as const;
const IT: CellAttrs = { it: 1 };
const BG: CellAttrs = { bg: '#00ff00' };
const BL: CellAttrs = { bl: 1 };

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: id };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000.5, seed: 7, computed: false, sheets };
}

function moveOf(from: Rect, toRow: number, toColumn: number, toSheet = 'a', sheet = 'a'): MoveOp {
    return { kind: 'move', sheet, from, toSheet, toRow, toColumn };
}

function whole(look: CellAttrs, ranges: Rect[], sheet = 'a'): FormatOp {
    return { kind: 'format', sheet, ranges, set: look, clear: LOOK_KEYS.filter((key) => look[key] === undefined) };
}

function expectValid(ops: readonly Op[]): void {
    const text = JSON.stringify({ g: 1, now: 1, seed: 1, ops: [...ops] } satisfies Batch);
    expect(readBatch(text)).toEqual(JSON.parse(text));
}

// LAW 2 and law 8 on one batch: the book reads as the model after it and after its inverse, which holds the bands
// canonical; the inverse restores the bytes and passes the validators; its own inverse gives the bytes after.
function expectLaw2(content: Book, ops: readonly Op[]): Op[] {
    const book = new Workbook(content);
    const before = bytes(book);
    const expected = modelAfter(modelOf(content), { now: content.now, seed: content.seed, ops: [...ops] });
    if (typeof expected === 'string') throw new Error(`the model refused: ${expected}`);
    const inverse = applyOps(book, ops);
    expectReads(book, expected);
    const after = bytes(book);
    expectValid(inverse);
    const again = applyOps(book, inverse);
    expect(bytes(book)).toBe(before);
    expectReads(book, modelOf(content));
    applyOps(book, again);
    expect(bytes(book)).toBe(after);
    expectReads(book, expected);
    return inverse;
}

function refusalOf(book: Workbook, ops: readonly Op[]): RefusalKey | undefined {
    try {
        applyOps(book, ops);
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
    return undefined;
}

// Sheet a: the block A1:B4 holds values, formulas, a rich linked cell, a marked one, a merge, a comment and a rule
// range, and wears italic. It moves to B3:C6, which overlaps it: outside the block that holds a value, a link alone,
// a formula and a linked value, a merge, a comment and a rule range, and wears green and bold. Formulas on a and b
// read the block, and some read where it lands.
const A = sheetOf('a', {
    cells: [
        [0, 0, { v: 1 }],
        [1, 0, { f: '=R[-1]C*2' }],
        [3, 0, { f: '=R[1]C[1]' }],
        [8, 0, { f: '=SUM(R1C1:R4C2)' }],
        [9, 0, { f: '=R6C3' }],
        [0, 1, { s: [...RICH], link: LINK }],
        [2, 1, { v: 'q', qp: 1 }],
        [3, 1, { v: 2 }],
        [4, 1, { v: 't1' }],
        [2, 2, { v: 'l', link: LINK }],
        [4, 2, { link: OTHER }],
        [5, 2, { f: '=R1C1+1' }],
    ],
    looks: [IT, BG, BL],
    bands: [0, 2, 0, 1, 4, 0, 1, 3, 0, 1, 4, 2, 6, 0, 2, 5, 0, 0, 2, 3, 3, 0, 4, 2, 6, 0, 3, 0],
    records: {
        merge: { in: { rect: [0, 0, 1, 0] }, landed: { rect: [5, 1, 5, 2] } },
        comment: { bc: { row: 0, column: 1 }, tc: { row: 4, column: 2 } },
        conditionalFormat: { r: formulaRule([[0, 0, 1, 1]], '=RC>1') },
        validation: {
            v: { ranges: [[4, 1, 4, 1]], order: 'a0', rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' } },
        },
    },
});
const B = sheetOf('b', {
    cells: [
        [0, 0, { f: '=[a]!R5C2' }],
        [1, 0, { f: '=[a]!R1C1' }],
    ],
});
const OVERLAP = moveOf([0, 0, 3, 1], 2, 1);

describe('engine/book/apply-move — what a move writes', () => {
    test('the block goes along with its content, looks, extras, comments, merges and rule ranges', () => {
        expectLaw2(bookOf(A, B), [OVERLAP]);
        const book = new Workbook(bookOf(A, B));
        applyOps(book, [OVERLAP]);
        expect(book.engine.valueOf('a', 2, 1)).toBe(1);
        expect(book.engine.formulaOf('a', 3, 1)).toBe('=R[-1]C*2');
        expect(book.sheets.get('a')?.extras.at(2, 2)).toEqual({ s: [...RICH], link: LINK });
        expect(book.sheets.get('a')?.extras.at(4, 2)).toEqual({ qp: 1 });
        expect(book.sheets.get('a')?.records.records('merge').get('in')).toEqual({ rect: [2, 1, 3, 1] });
        expect(book.sheets.get('a')?.records.records('conditionalFormat').get('r')?.ranges).toEqual([[2, 1, 3, 2]]);
        expect(book.sheets.get('a')?.records.comments(2, 2)).toEqual(['bc']);
        expect(book.looks.look(book.sheets.get('a')?.bands.look(5, 2) ?? 0)).toEqual(IT);
    });

    test('the source is left empty and plain, and what the block lands on is replaced', () => {
        const book = new Workbook(bookOf(A, B));
        applyOps(book, [moveOf([0, 0, 3, 1], 0, 4)]);
        const bands = book.sheets.get('a')?.bands;
        for (const [row, column] of [
            [0, 0],
            [3, 1],
            [2, 0],
        ])
            expect(bands?.look(row, column)).toBe(0);
        expect(book.looks.look(bands?.look(0, 4) ?? 0)).toEqual(IT);
        expect(book.engine.valueOf('a', 0, 0)).toBeNull();
        expect(book.sheets.get('a')?.extras.at(0, 1)).toBeUndefined();
        expect(book.sheets.get('a')?.extras.at(0, 5)).toEqual({ s: [...RICH], link: LINK });
    });

    test('a comment where the block lands goes, and the ones it brings take its place', () => {
        const book = new Workbook(bookOf(A, B));
        applyOps(book, [moveOf([0, 1, 0, 1], 4, 2)]);
        expect(book.sheets.get('a')?.records.comments(4, 2)).toEqual(['bc']);
        expect(book.sheets.get('a')?.records.records('comment').has('tc')).toBe(false);
        expectLaw2(bookOf(A, B), [moveOf([0, 1, 0, 1], 4, 2)]);
        expectLaw2(bookOf(A, B), [moveOf([0, 0, 3, 1], 4, 2, 'b')]);
    });

    test('to another sheet the looks cross through the one look table, and rule ranges stay', () => {
        const op = moveOf([0, 0, 3, 1], 2, 1, 'b');
        expectLaw2(bookOf(A, B), [op]);
        const book = new Workbook(bookOf(A, B));
        applyOps(book, [op]);
        const b = book.sheets.get('b');
        expect(book.looks.look(b?.bands.look(2, 1) ?? 0)).toEqual(IT);
        expect(book.looks.look(b?.bands.look(5, 2) ?? 0)).toEqual(IT);
        expect(b?.records.records('merge').get('in')).toEqual({ rect: [2, 1, 3, 1] });
        expect(b?.records.comments(2, 2)).toEqual(['bc']);
        expect(book.sheets.get('a')?.records.records('conditionalFormat').get('r')?.ranges).toEqual([[0, 0, 1, 1]]);
    });

    test('a block moved onto itself changes nothing and has no inverse', () => {
        const book = new Workbook(bookOf(A, B));
        const before = bytes(book);
        expect(applyOps(book, [moveOf([0, 0, 3, 1], 0, 0)])).toEqual([]);
        expect(bytes(book)).toBe(before);
    });

    test('a move from or to a sheet the book does not hold is skipped alone', () => {
        for (const op of [moveOf([0, 0, 3, 1], 2, 1, 'gone'), moveOf([0, 0, 3, 1], 2, 1, 'a', 'gone')]) {
            const book = new Workbook(bookOf(A, B));
            const before = bytes(book);
            expect(applyOps(book, [op])).toEqual([]);
            expect(bytes(book)).toBe(before);
        }
    });

    test('a whole column, a whole row and a single cell move', () => {
        expectLaw2(bookOf(A, B), [moveOf([0, 0, LAST_ROW, 0], 0, 3)]);
        expectLaw2(bookOf(A, B), [moveOf([3, 0, 3, LAST_COLUMN], 2, 0)]);
        expectLaw2(bookOf(A, B), [moveOf([3, 0, 3, 0], 4, 1)]);
        expectLaw2(bookOf(A, B), [moveOf([0, 0, LAST_ROW, 0], 0, 1, 'b')]);
    });

    test('a move, its undo and its redo', () => {
        const book = new Workbook(bookOf(A, B));
        const before = bytes(book);
        const undo = applyOps(book, [OVERLAP]);
        const after = bytes(book);
        const redo = applyOps(book, undo);
        expect(bytes(book)).toBe(before);
        const again = applyOps(book, redo);
        expect(bytes(book)).toBe(after);
        applyOps(book, again);
        expect(bytes(book)).toBe(before);
    });
});

describe('engine/book/apply-move — the inverse, part by part', () => {
    const inverse = (op: MoveOp = OVERLAP) => applyOps(new Workbook(bookOf(A, B)), [op]);

    test('(1) it opens with the move back', () => {
        expect(inverse()[0]).toEqual({
            kind: 'move',
            sheet: 'a',
            from: [2, 1, 5, 2],
            toSheet: 'a',
            toRow: 0,
            toColumn: 0,
        });
    });

    test('(2) the looks of the landed-on cells outside the block come back whole, one op per look', () => {
        const formats = inverse().filter((op) => op.kind === 'format');
        expect(formats).toEqual([whole(BG, [[4, 1, 5, 2]]), whole(BL, [[2, 2, 2, 2]])]);
        // To another sheet every landed-on cell is outside the block.
        const across = inverse(moveOf([4, 1, 5, 2], 0, 0, 'b', 'a'));
        expect(across.filter((op) => op.kind === 'format')).toEqual([]);
        const back = applyOps(new Workbook(bookOf(A, B)), [moveOf([0, 0, 0, 0], 4, 1, 'a', 'b')]);
        expect(back.filter((op) => op.kind === 'format')).toEqual([whole(BG, [[4, 1, 4, 1]])]);
    });

    test('(3) one input writes back their content, the cells inside the block left to the move back', () => {
        const inputs = inverse().filter((op): op is InputOp => op.kind === 'input');
        expect(inputs[0]).toEqual({
            kind: 'input',
            sheet: 'a',
            cells: [
                [4, 1, { v: 't1' }],
                [2, 2, { v: 'l', link: LINK }],
                [4, 2, { link: OTHER }],
                [5, 2, { f: '=R1C1+1' }],
            ],
        });
    });

    test('(4) the records the move removed or the move back would carry come back after it', () => {
        expect(inverse().filter((op) => op.kind === 'record')).toEqual([
            { kind: 'record', sheet: 'a', type: 'merge', id: 'landed', set: { rect: [5, 1, 5, 2] }, whole: 1 },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'tc', set: { row: 4, column: 2 }, whole: 1 },
            { kind: 'record', sheet: 'a', type: 'validation', id: 'v', set: A.records.validation?.v },
        ]);
    });

    test('(4) a comment where the block overlaps itself goes along and back, and needs no record op', () => {
        // B4 is in the block and where it lands; C5 is only landed on, so it comes back after the move back.
        const comment = { bc: { row: 0, column: 1 }, oc: { row: 3, column: 1 }, tc: { row: 4, column: 2 } };
        const content = bookOf({ ...A, records: { ...A.records, comment } }, B);
        const ops = expectLaw2(content, [OVERLAP]);
        expect(ops.filter((op) => op.kind === 'record')).toEqual([
            { kind: 'record', sheet: 'a', type: 'merge', id: 'landed', set: { rect: [5, 1, 5, 2] }, whole: 1 },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'tc', set: { row: 4, column: 2 }, whole: 1 },
            { kind: 'record', sheet: 'a', type: 'validation', id: 'v', set: A.records.validation?.v },
        ]);
        const book = new Workbook(content);
        applyOps(book, [OVERLAP]);
        expect(Object.fromEntries(book.sheets.get('a')?.records.records('comment') ?? [])).toEqual({
            bc: { row: 2, column: 2 },
            oc: { row: 5, column: 2 },
        });
    });

    test('(5) the formulas the move made lossy come back last, per sheet, where the move back leaves them', () => {
        const ops = inverse();
        expect(ops.slice(-2)).toEqual([
            {
                kind: 'input',
                sheet: 'a',
                cells: [
                    [3, 0, { f: '=R[1]C[1]' }],
                    [9, 0, { f: '=R6C3' }],
                ],
            },
            { kind: 'input', sheet: 'b', cells: [[0, 0, { f: '=[a]!R5C2' }]] },
        ]);
    });

    test('the parts come in the order (1) to (5)', () => {
        const ops = inverse();
        expect(ops.map((op) => op.kind)).toEqual([
            'move',
            'format',
            'format',
            'input',
            'record',
            'record',
            'record',
            'input',
            'input',
        ]);
    });

    test('(5) a lossy run of formulas the block carries comes back where it came from', () => {
        const sheet = sheetOf('a', {
            cells: [
                [0, 0, { f: '=RC[1]' }],
                [1, 0, { f: '=RC[1]' }],
                [2, 0, { f: '=RC[1]' }],
            ],
        });
        const ops = expectLaw2(bookOf(sheet), [moveOf([0, 0, 2, 0], 0, 1)]);
        expect(ops.at(-1)).toEqual({ kind: 'input', sheet: 'a', runs: [[[0, 0, 2, 0], { f: '=RC[1]' }]] });
    });

    test('a move onto an empty area has the move back alone', () => {
        expect(inverse(moveOf([0, 0, 3, 1], 30, 30))).toEqual([moveOf([30, 30, 33, 31], 0, 0)]);
    });
});

describe('engine/book/apply-move — refusals leave the book as it was', () => {
    const LONG = `="${'a'.repeat(131_050)}"&R1C1`;
    const ID = 'c'.repeat(60);
    const cases: [RefusalKey, Book, MoveOp][] = [
        ['merge-cut', bookOf(A, B), moveOf([0, 0, 0, 0], 10, 10)],
        ['merge-cut', bookOf(A, B), moveOf([10, 10, 10, 11], 5, 0)],
        ['merge-cut', bookOf(A, B), moveOf([10, 10, 10, 10], 5, 1, 'a', 'b')],
        [
            'key-too-long',
            bookOf(
                A,
                sheetOf(ID, {
                    records: {
                        conditionalFormat: { r: formulaRule([[0, 0, 0, 0]], LONG.replace('R1C1', '[a]!R4C4')) },
                    },
                }),
            ),
            moveOf([3, 3, 3, 3], 0, 0, ID),
        ],
        [
            'key-too-long',
            bookOf(sheetOf('a', { cells: [[0, 5, { f: LONG }]] }), sheetOf(ID)),
            moveOf([0, 0, 0, 0], 4, 4, ID),
        ],
    ];
    for (const [key, content, op] of cases) {
        test(`${key} by ${JSON.stringify(op.from)} to ${op.toSheet.slice(0, 2)}`, () => {
            const book = new Workbook(content);
            const before = bytes(book);
            const landing: InputOp = { kind: 'input', sheet: 'a', cells: [[20, 20, { v: 9 }]] };
            expect(refusalOf(book, [landing, op])).toBe(key);
            expect(bytes(book)).toBe(before);
            expect(modelAfter(modelOf(content), { now: 1, seed: 1, ops: [landing, op] })).toBe(key);
            expectReads(book, modelOf(content));
        });
    }

    test('the sheet the block leaves is asked first, so a cut there refuses before a clash where it lands', () => {
        const source = sheetOf('a', {
            fields: { name: 'a', order: 'a1' },
            records: { merge: { m: { rect: [0, 0, 1, 1] }, n: { rect: [1, 2, 2, 2] } } },
        });
        const first = sheetOf('b', {
            fields: { name: 'b', order: 'a0' },
            records: { merge: { m: { rect: [9, 9, 9, 10] } } },
        });
        const book = new Workbook(bookOf(source, first));
        expect(refusalOf(book, [moveOf([0, 0, 1, 2], 4, 4, 'b')])).toBe('merge-cut');
    });

    test('the sheet the block leaves plans whole first, so its rule past the bound refuses before a cut where it lands', () => {
        const source = sheetOf('a', { records: { conditionalFormat: { r: formulaRule([[40, 0, 40, 0]], LONG) } } });
        const content = bookOf(source, sheetOf(ID, { records: { merge: { m: { rect: [5, 5, 5, 6] } } } }));
        const op = moveOf([0, 0, 0, 0], 5, 5, ID);
        expect(refusalOf(new Workbook(content), [op])).toBe('key-too-long');
        expect(modelAfter(modelOf(content), { now: 1, seed: 1, ops: [op] })).toBe('key-too-long');
    });

    test('a merge the block lands on whole is removed and comes back', () => {
        const book = new Workbook(bookOf(A, B));
        applyOps(book, [moveOf([10, 0, 10, 2], 5, 1)]);
        expect(book.sheets.get('a')?.records.records('merge').has('landed')).toBe(false);
        expectLaw2(bookOf(A, B), [moveOf([10, 0, 10, 2], 5, 1)]);
    });
});

describe('engine/book/apply-move — beside the line edits of one batch', () => {
    const linesOf = (rows: boolean, insert: boolean, index: number, count: number, sheet = 'a'): LinesOp => ({
        kind: 'lines',
        sheet,
        rows,
        insert,
        index,
        count,
    });
    // A filter from row 3 to the grid's last, with filtered rows, over the cells the moves cross.
    const FILTERED = sheetOf('a', {
        ...A,
        records: {
            ...A.records,
            filter: { f: { rect: [2, 0, LAST_ROW, 4] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [[3, 4]] } },
        },
    });

    test('rows inserted through the block, then the block moved across them', () => {
        expectLaw2(bookOf(A, B), [linesOf(true, true, 2, 2), moveOf([0, 0, 5, 1], 3, 1)]);
    });

    test('a column deleted through the block, then the block moved to another sheet', () => {
        expectLaw2(bookOf(A, B), [linesOf(false, false, 1, 1), moveOf([0, 0, 4, 1], 1, 1, 'b')]);
    });

    test('a move, then rows deleted through where the block landed', () => {
        expectLaw2(bookOf(A, B), [OVERLAP, linesOf(true, false, 3, 2)]);
        expectLaw2(bookOf(A, B), [moveOf([0, 0, 3, 1], 0, 0, 'b'), linesOf(true, false, 1, 2, 'b')]);
    });

    test('a move, then a column inserted inside the landed block, then a move across it', () => {
        expectLaw2(bookOf(A, B), [OVERLAP, linesOf(false, true, 2, 1), moveOf([2, 1, 5, 3], 8, 0)]);
    });

    test('a filter stays where a move leaves it, and its start then moves with a row inserted above', () => {
        const content = bookOf(FILTERED, B);
        const book = new Workbook(content);
        applyOps(book, [moveOf([0, 0, 4, 1], 6, 6)]);
        expect(book.content().sheets[0]?.records.filter).toEqual({ f: { rect: [2, 0, LAST_ROW, 4] } });
        expectLaw2(content, [moveOf([0, 0, 4, 1], 6, 6), linesOf(true, true, 0, 1), moveOf([7, 6, 9, 7], 1, 2)]);
    });
});

describe('engine/book/apply-move — the laws over random books and batches of moves among every kind built', () => {
    test('LAW 1, LAW 2, law 6 and law 8', () => {
        const counts = new Map<string, number>();
        const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
        for (let seed = 1; seed <= 400; seed += 1) {
            const random = randomOf(seed);
            const content = randomBookContent(random);
            const book = new Workbook(content);
            let model: Model = modelOf(content);
            for (let round = 0; round < 8; round += 1) {
                // One batch in two is a single move, whose inverse is read part by part.
                const single = random() < 0.5;
                const ops = batchOf(
                    random,
                    model,
                    (r, m) => {
                        const draw = r();
                        if (single || draw < 0.5) return randomMoveOp(r, m);
                        if (draw < 0.6) return randomLandingReaderOp(r, m);
                        if (draw < 0.65) return randomInputOp(r, m);
                        if (draw < 0.72) return randomFormatOp(r, m);
                        return draw < 0.93 ? randomRecordOp(r, m) : randomSheetOp(r, m);
                    },
                    single ? 1 : 5,
                );
                for (const op of ops.ops) if (op.kind === 'move') count(classOf(model, op));
                const before = bytes(book);
                const expected = modelAfter(model, ops);
                if (typeof expected === 'string') {
                    count(`refused ${expected}`);
                    expect(refusalOf(book, ops.ops)).toBe(expected);
                    expect(bytes(book)).toBe(before);
                    expectReads(book, model);
                    continue;
                }
                const inverse = applyOps(book, ops.ops);
                book.setClock(ops.now, ops.seed);
                expectReads(book, expected);
                const after = bytes(book);
                expectValid(inverse);
                const [op] = ops.ops;
                if (single && op.kind === 'move' && inverse.length > 0)
                    for (const part of partsOf(model, op, inverse)) count(part);
                const again = applyOps(book, inverse);
                book.setClock(model.now, model.seed);
                expect(bytes(book)).toBe(before);
                expectReads(book, model);
                applyOps(book, again);
                book.setClock(ops.now, ops.seed);
                expect(bytes(book)).toBe(after);
                model = expected;
                count('landed');
            }
        }
        const at = (key: string) => counts.get(key) ?? 0;
        expect(at('landed')).toBeGreaterThan(2000);
        for (const key of ['up', 'down', 'left', 'right']) expect(at(`overlap ${key}`)).toBeGreaterThan(80);
        for (const key of ['apart', 'across', 'onto itself', 'no source', 'no target', 'whole line']) {
            expect(at(key)).toBeGreaterThan(40);
        }
        expect(at('refused merge-cut')).toBeGreaterThan(100);
        for (const key of ['looks', 'content', 'records', 'lost']) expect(at(`part ${key}`)).toBeGreaterThan(30);
    }, 300_000);
});

// What a move does, by where its block lands against where it is.
function classOf(model: Model, { sheet, toSheet, from, toRow, toColumn }: MoveOp): string {
    if (!model.sheets.has(sheet)) return 'no source';
    if (!model.sheets.has(toSheet)) return 'no target';
    if (from[2] - from[0] === LAST_ROW || from[3] - from[1] === LAST_COLUMN) return 'whole line';
    if (sheet !== toSheet) return 'across';
    const down = toRow - from[0];
    const right = toColumn - from[1];
    if (down === 0 && right === 0) return 'onto itself';
    if (Math.abs(down) > from[2] - from[0] || Math.abs(right) > from[3] - from[1]) return 'apart';
    return `overlap ${Math.abs(down) >= Math.abs(right) ? (down > 0 ? 'down' : 'up') : right > 0 ? 'right' : 'left'}`;
}

// The parts of a move's inverse it holds: after the move back, whole-look formats, the input of the landed-on cells
// when they held content, records, and the inputs of lossy formulas.
function partsOf(model: Model, op: MoveOp, inverse: readonly Op[]): string[] {
    const parts: string[] = [];
    if (inverse.some((part) => part.kind === 'format')) parts.push('part looks');
    if (inverse.some((part) => part.kind === 'record')) parts.push('part records');
    const [top, left, bottom, right] = op.from;
    const target: Rect = [op.toRow, op.toColumn, op.toRow + bottom - top, op.toColumn + right - left];
    const held = [...(model.sheets.get(op.toSheet)?.cells.keys() ?? [])].some((place) => {
        const [row, column] = place.split(',').map(Number);
        const inside = (rect: Rect) => row >= rect[0] && row <= rect[2] && column >= rect[1] && column <= rect[3];
        return inside(target) && !(op.sheet === op.toSheet && inside(op.from));
    });
    if (held) parts.push('part content');
    if (inverse.filter((part) => part.kind === 'input').length > (held ? 1 : 0)) parts.push('part lost');
    return parts;
}
