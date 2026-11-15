import { describe, expect, test } from 'bun:test';
import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Batch, InputOp, Op, SheetContent, SheetFields, SheetOp } from '@workspace/lib/sheets/ops';
import { opReferences } from '@workspace/lib/sheets/ops';
import { isSheetContent, readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { canonical } from './book-fixtures';
import { bytes } from './bytes';
import { expectReads, modelAfter, modelOf } from './model';
import { formulaRule } from './records-fixtures';

const PARTS = newChartSpecParts(sampleChartSpec('column'));
const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
// An id as long as an id may be, so a formula bound to it grows.
const LONG_ID = 'c'.repeat(60);

function sheetOf(id: string, fields: Partial<SheetFields> = {}, part: Partial<SheetContent> = {}): SheetContent {
    return {
        id,
        fields: { name: id, order: 'a0', ...fields },
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
    return { g: 1, now: 45_000.5, seed: 7, sheets };
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

function names(book: Workbook): string[] {
    return book.content().sheets.map((sheet) => sheet.fields.name);
}

// A sheet that holds something of every part: cells of every kind, a spill mark, looks said the long way round, line
// keys in pieces and a record of every type.
function fullSheet(id: string, fields: Partial<SheetFields> = {}): SheetContent {
    return sheetOf(id, fields, {
        cells: [
            [0, 0, { v: 2 }],
            [1, 0, { v: 'text', link: LINK }],
            [2, 0, { v: true }],
            [3, 0, { v: '#N/A', e: 1 }],
            [4, 0, { f: '=R1C1*3', v: 6 }],
            [5, 0, { f: "='[b.xlsx]S'!R1C1", v: 4 }],
            [
                6,
                0,
                {
                    s: [
                        { v: 'bold ', bl: 1 },
                        { v: 'red', fc: '#ff0000' },
                    ],
                },
            ],
            [7, 0, { v: 'quoted', qp: 1 }],
            [8, 0, { link: LINK }],
            [9, 0, { v: 5, spill: 1 }],
            [0, 1, { f: '=[a]!R1C1+1' }],
        ],
        looks: [{ bl: 1 }, { it: 1, fc: '#ff0000' }, { fc: '#ff0000', it: 1 }],
        bands: [0, 2, 0, 1, 3, 1, 1, 2, 0, 2, 4, 3, 2, 1, 0, 1],
        rows: [
            [[1, 2], { size: 30 }],
            [[3, 3], { size: 30 }],
        ],
        columns: [[[0, 0], { hidden: 1 }]],
        records: {
            merge: { m: { rect: [20, 0, 21, 1] } },
            filter: { f: { rect: [30, 0, 40, 3] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [[31, 32]] } },
            comment: { c1: { row: 0, column: 0 }, c2: { row: 1, column: 0 } },
            conditionalFormat: { r: formulaRule([[0, 0, 9, 0]], '=RC>1') },
            validation: {
                v: {
                    ranges: [[0, 2, 3, 2]],
                    order: 'a1',
                    rule: { type: 'dropdown', type2: '', value1: 'a,b', value2: '' },
                },
            },
            image: { i: { index: 'a0', x: 1, y: 2, width: 30, height: 40, mediaName: 'picture.png' } },
            chart: { g: { index: 'a1', x: 0, y: 0, width: 1, height: 1, ...PARTS } },
        },
    });
}

function addOf(content: SheetContent): SheetOp {
    return { kind: 'sheet', add: content };
}

// LAW 2 on one batch: the inverse passes the validators and restores the bytes, and its inverse gives the bytes after.
function expectLaw2(content: Book, ops: Op[]): Op[] {
    const book = new Workbook(content);
    const before = bytes(book);
    const inverse = applyOps(book, ops);
    const after = bytes(book);
    expect(after).not.toBe(before);
    const batch: Batch = { g: 1, now: content.now, seed: content.seed, ops: inverse };
    const text = JSON.stringify(batch);
    expect(readBatch(text)).toEqual(JSON.parse(text));
    const again = applyOps(book, inverse);
    expect(bytes(book)).toBe(before);
    applyOps(book, again);
    expect(bytes(book)).toBe(after);
    return inverse;
}

// The book after the ops as the model applies them, which a real book must read as.
function expectModel(content: Book, book: Workbook, ops: Op[]): void {
    const model = modelAfter(modelOf(content), { now: content.now, seed: content.seed, ops });
    if (typeof model === 'string') throw new Error(`refused: ${model}`);
    expectReads(book, model);
}

describe('engine/book/apply-sheet — an add', () => {
    test('a sheet lands as a load of it does, in its place among the tabs, and its inverse is its delete', () => {
        const base = bookOf(sheetOf('a'), sheetOf('z', { order: 'a2' }));
        const added = fullSheet('b', { order: 'a1', name: 'Added' });
        const book = new Workbook(base);
        expect(applyOps(book, [addOf(added)])).toEqual([{ kind: 'sheet', delete: 'b' }]);
        const loaded = new Workbook({ ...base, sheets: [...base.sheets, added] });
        expect(bytes(book)).toBe(bytes(loaded));
        expect([0, 1, 2].map((place) => book.engine.sheetAt(place))).toEqual(['a', 'b', 'z']);
        expectModel(base, book, [addOf(added)]);
        // The bands are the canonical ones, and the spill mark is dropped.
        const [, read] = book.content().sheets;
        const { spill: _, ...spilled } = added.cells[9][2];
        expect(read.cells[9]).toEqual([9, 0, spilled]);
        const shown = canonical({ ...base, sheets: [added] }).sheets[0];
        expect({ looks: read.looks, bands: read.bands }).toEqual({ looks: shown.looks, bands: shown.bands });
    });

    test('a sheet whose id the book holds is skipped alone', () => {
        const book = new Workbook(bookOf(sheetOf('a'), sheetOf('b', { order: 'a1' })));
        const before = bytes(book);
        expect(applyOps(book, [addOf(fullSheet('b', { name: 'Other' }))])).toEqual([]);
        expect(bytes(book)).toBe(before);
    });

    test('a name in use, in any case, takes the first free suffix, from (2), cut to fit 31 characters', () => {
        const long = 'x'.repeat(31);
        const book = new Workbook(bookOf(sheetOf('a', { name: 'Data' }), sheetOf('l', { name: long, order: 'a1' })));
        applyOps(book, [
            addOf(sheetOf('b', { name: 'DATA', order: 'a2' })),
            addOf(sheetOf('c', { name: 'data', order: 'a3' })),
            addOf(sheetOf('d', { name: long.toUpperCase(), order: 'a4' })),
            addOf(sheetOf('e', { name: long, order: 'a5' })),
            addOf(sheetOf('f', { name: 'Free', order: 'a6' })),
        ]);
        expect(names(book)).toEqual([
            'Data',
            long,
            'DATA (2)',
            'data (3)',
            `${'X'.repeat(27)} (2)`,
            `${'x'.repeat(27)} (3)`,
            'Free',
        ]);
        for (const sheet of book.content().sheets) expect(isSheetContent(JSON.parse(JSON.stringify(sheet)))).toBe(true);
        // A cut name whose suffix is free of the cut name's sheets takes the first suffix free.
        const near = new Workbook(bookOf(sheetOf('a', { name: 'N (2)' }), sheetOf('b', { name: 'N', order: 'a1' })));
        applyOps(near, [addOf(sheetOf('c', { name: 'n', order: 'a2' }))]);
        expect(names(near)).toEqual(['N (2)', 'N', 'n (3)']);
    });

    test('an add binds the formulas typed with its name, and its inverse is the delete first, then their text', () => {
        const typed = "='Later'!R1C1+1";
        const base = bookOf(sheetOf('a', {}, { cells: [[0, 0, { f: typed, link: LINK }]] }));
        const added = sheetOf('b', { name: 'later', order: 'a1' }, { cells: [[0, 0, { v: 41 }]] });
        const book = new Workbook(base);
        const inverse = applyOps(book, [addOf(added)]);
        expect(book.engine.formulaOf('a', 0, 0)).toBe('=[b]!R1C1+1');
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toBe(42);
        const lost: InputOp = { kind: 'input', sheet: 'a', cells: [[0, 0, { f: typed, link: LINK }]] };
        expect(inverse).toEqual([{ kind: 'sheet', delete: 'b' }, lost]);
        expectModel(base, book, [addOf(added)]);
        expectLaw2(base, [addOf(added)]);
    });

    test('an add the engine refuses, as a formula it binds would be too long, writes nothing, looks included', () => {
        const long = `="${'a'.repeat(131_010)}"&'N'!R1C1`;
        const base = bookOf(sheetOf('a', {}, { cells: [[0, 0, { f: long }]] }));
        const book = new Workbook(base);
        const before = bytes(book);
        const looks = book.looks.size;
        const refused = fullSheet(LONG_ID, { name: 'N', order: 'a1' });
        expect(refusalOf(() => applyOps(book, [addOf(refused)]))).toBe('key-too-long');
        expect(bytes(book)).toBe(before);
        expect(book.looks.size).toBe(looks);
        expect([...book.sheets.keys()]).toEqual(['a']);
        expectReads(book, modelOf(base));
    });
});

describe('engine/book/apply-sheet — a delete', () => {
    test('a sheet the book does not hold is skipped alone', () => {
        const book = new Workbook(bookOf(sheetOf('a')));
        const before = bytes(book);
        expect(applyOps(book, [{ kind: 'sheet', delete: 'gone' }])).toEqual([]);
        expect(bytes(book)).toBe(before);
    });

    test('deleting the last shown sheet is refused, hidden sheets counted, and deleting a hidden one is not', () => {
        const alone = new Workbook(bookOf(sheetOf('a')));
        expect(refusalOf(() => applyOps(alone, [{ kind: 'sheet', delete: 'a' }]))).toBe('last-sheet');
        const content = bookOf(sheetOf('a'), sheetOf('b', { hide: 1, order: 'a1' }), sheetOf('c', { order: 'a2' }));
        const book = new Workbook(content);
        const before = bytes(book);
        expect(
            refusalOf(() =>
                applyOps(book, [
                    { kind: 'sheet', delete: 'c' },
                    { kind: 'sheet', delete: 'a' },
                ]),
            ),
        ).toBe('last-sheet');
        expect(bytes(book)).toBe(before);
        applyOps(book, [
            { kind: 'sheet', delete: 'b' },
            { kind: 'sheet', delete: 'c' },
        ]);
        expect([...book.sheets.keys()]).toEqual(['a']);
        expect(book.engine.sheetAt(0)).toBe('a');
    });

    test('its inverse is the add of the sheet whole, as the book lists it, images and comments named', () => {
        const content = bookOf(sheetOf('a'), fullSheet('b', { order: 'a1', hide: 1, color: '#123456' }));
        const book = new Workbook(content);
        bytes(book);
        const listed = book.content().sheets[1];
        const inverse = applyOps(book, [{ kind: 'sheet', delete: 'b' }]);
        expect(inverse).toEqual([{ kind: 'sheet', add: listed }]);
        expect([...book.sheets.keys()]).toEqual(['a']);
        expect(opReferences(inverse[0])).toEqual({ media: ['picture.png'], comments: ['c1', 'c2'] });
        expectLaw2(content, [{ kind: 'sheet', delete: 'b' }]);
    });

    test('a formula that reads the deleted sheet reads #REF!, and the undo brings its value back', () => {
        const reader = sheetOf('a', {}, { cells: [[0, 0, { f: '=[b]!R1C1*2' }]] });
        const content = bookOf(reader, sheetOf('b', { name: 'Data', order: 'a1' }, { cells: [[0, 0, { v: 21 }]] }));
        const book = new Workbook(content);
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toBe(42);
        const inverse = applyOps(book, [{ kind: 'sheet', delete: 'b' }]);
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toMatchObject({ text: '#REF!' });
        expect(book.engine.formulaOf('a', 0, 0)).toBe('=[b]!R1C1*2');
        applyOps(book, inverse);
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toBe(42);
        expectLaw2(content, [{ kind: 'sheet', delete: 'b' }]);
    });

    test('the undo of a delete brings the sheet back under its own name, which an add in its batch took', () => {
        const content = bookOf(sheetOf('a'), fullSheet('b', { name: 'Data', order: 'a1' }));
        const ops: Op[] = [
            { kind: 'sheet', delete: 'b' },
            addOf(sheetOf('c', { name: 'DATA', order: 'a2' }, { cells: [[0, 0, { v: 1 }]] })),
        ];
        const book = new Workbook(content);
        const inverse = applyOps(book, ops);
        expect(names(book)).toEqual(['a', 'DATA']);
        applyOps(book, inverse);
        expect(names(book)).toEqual(['a', 'Data']);
        expectLaw2(content, ops);
    });
});

describe('engine/book/apply-sheet — LAW 2 within one batch', () => {
    test('an add then its delete, and a delete then the add of the same sheet', () => {
        const content = bookOf(
            sheetOf('a', {}, { cells: [[0, 0, { f: "='New'!R1C1" }]] }),
            fullSheet('b', { order: 'a1' }),
        );
        const added = fullSheet('n', { name: 'New', order: 'a2' });
        // The delete leaves the formula the add bound reading the id, and the inverse writes back its typed text.
        expectLaw2(content, [addOf(added), { kind: 'sheet', delete: 'n' }]);

        const listed = new Workbook(content).content().sheets[1];
        const back = { ...listed, fields: { ...listed.fields, name: 'Back', order: 'a3' } };
        expectLaw2(content, [{ kind: 'sheet', delete: 'b' }, addOf(back)]);
        expectLaw2(content, [
            addOf(added),
            { kind: 'sheet', delete: 'b' },
            { kind: 'record', sheet: 'n', type: 'sheet', id: 'n', set: { name: 'Renamed' } },
        ]);
    });
});

describe('engine/book/apply-sheet — the look table', () => {
    test('a delete’s looks leave the table at the sweep, and a sweep moves no byte', () => {
        const content = bookOf(sheetOf('a'), fullSheet('b', { order: 'a1' }));
        const book = new Workbook(content);
        for (let i = 0; i < 100; i += 1) book.looks.intern({ fs: 100 + i });
        applyOps(book, [{ kind: 'sheet', delete: 'b' }]);
        expect(book.looks.size).toBe(1);
        const added = fullSheet('n', { order: 'a2' });
        const loaded = new Workbook({ ...content, sheets: [sheetOf('a'), added] });
        applyOps(book, [addOf(added)]);
        expect(book.looks.size).toBe(3);
        expect(bytes(book)).toBe(bytes(loaded));
    });
});

describe('engine/book/apply-sheet — the content read', () => {
    test('every part of a sheet rides in the add its delete gives back', () => {
        const content = bookOf(sheetOf('a'), fullSheet('b', { order: 'a1' }));
        const book = new Workbook(content);
        const [inverse] = applyOps(book, [{ kind: 'sheet', delete: 'b' }]);
        if (inverse.kind !== 'sheet' || !('add' in inverse)) throw new Error('no add');
        const { add } = inverse;
        expect(add.cells).toHaveLength(11);
        expect(add.looks).toHaveLength(2);
        expect(add.bands.length).toBeGreaterThan(0);
        expect(add.rows).toEqual([[[1, 3], { size: 30 }]]);
        expect(add.columns).toEqual([[[0, 0], { hidden: 1 }]]);
        expect(add.cells.filter(([, , cell]) => cell.link || cell.qp || cell.s)).toHaveLength(4);
        expect(Object.keys(add.records).sort()).toEqual([
            'chart',
            'comment',
            'conditionalFormat',
            'filter',
            'filterColumn',
            'image',
            'merge',
            'validation',
        ]);
        expect(add.records.chart?.g).toEqual({ index: 'a1', x: 0, y: 0, width: 1, height: 1, ...PARTS });
    });
});
