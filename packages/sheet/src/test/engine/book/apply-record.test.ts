import { describe, expect, test } from 'bun:test';
import type { RecordOp, SheetContent, SheetFields } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { bytes } from './bytes';

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

function bookOf(...sheets: SheetContent[]): Workbook {
    return new Workbook({ g: 1, now: 45_000.5, seed: 7, computed: false, sheets });
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

function fields(id: string, set: RecordOp & { type: 'sheet' } extends { set: infer S } ? S : never): RecordOp {
    return { kind: 'record', sheet: id, type: 'sheet', id, set };
}

function tabs(book: Workbook): string[] {
    return book.content().sheets.map((sheet) => sheet.id);
}

describe('engine/book/apply-record — a sheet’s fields', () => {
    test('content() lists the sheets in tab order after an op changes a sheet’s order', () => {
        const book = bookOf(
            sheetOf('a', { order: 'a0' }),
            sheetOf('b', { order: 'a1' }),
            sheetOf('c', { order: 'a2' }),
        );
        expect(tabs(book)).toEqual(['a', 'b', 'c']);
        const inverse = applyOps(book, [fields('a', { order: 'a3' })]);
        expect(tabs(book)).toEqual(['b', 'c', 'a']);
        expect([0, 1, 2].map((place) => book.engine.sheetAt(place))).toEqual(['b', 'c', 'a']);
        applyOps(book, [fields('c', { order: 'a0' })]);
        expect(tabs(book)).toEqual(['c', 'b', 'a']);
        expect([0, 1, 2].map((place) => book.engine.sheetAt(place))).toEqual(['c', 'b', 'a']);
        // Two sheets of one order stand by id.
        applyOps(book, [fields('a', { order: 'a1' })]);
        expect(tabs(book)).toEqual(['c', 'a', 'b']);
        expect([0, 1, 2].map((place) => book.engine.sheetAt(place))).toEqual(['c', 'a', 'b']);
        applyOps(book, [fields('c', { order: 'a1' })]);
        expect(tabs(book)).toEqual(['a', 'b', 'c']);
        expect([0, 1, 2].map((place) => book.engine.sheetAt(place))).toEqual(['a', 'b', 'c']);
        expect(inverse).toEqual([fields('a', { order: 'a0' })]);
    });

    test('hiding the last shown sheet is refused, and hiding any other sheet is not', () => {
        const book = bookOf(sheetOf('a'), sheetOf('b', { hide: 1 }), sheetOf('c'));
        expect(applyOps(book, [fields('c', { hide: 1 })])).toEqual([fields('c', { hide: null })]);
        expect(refusalOf(() => applyOps(book, [fields('a', { hide: 1 })]))).toBe('last-sheet');
        expect(book.sheets.get('a')?.records.fields.hide).toBeUndefined();
        // A sheet that is hidden already is hidden again.
        expect(applyOps(book, [fields('b', { hide: 1 })])).toEqual([]);
        expect(applyOps(book, [fields('b', { hide: null })])).toEqual([fields('b', { hide: 1 })]);
        expect(applyOps(book, [fields('a', { hide: 1 })])).toEqual([fields('a', { hide: null })]);
        expect(refusalOf(() => applyOps(book, [fields('b', { hide: 1, color: '#ff0000' })]))).toBe('last-sheet');
        expect(book.sheets.get('b')?.records.fields.color).toBeUndefined();
    });

    test('a sheet that is hidden is not the last shown sheet: hiding it again is no refusal', () => {
        const book = bookOf(sheetOf('a', { hide: 1 }), sheetOf('b', { hide: 1 }));
        expect(applyOps(book, [fields('a', { hide: 1, color: '#ff0000' })])).toEqual([fields('a', { color: null })]);
    });

    test('a rename to a name another sheet has, in any case, is skipped alone with its other fields', () => {
        const book = bookOf(sheetOf('a', { name: 'Data' }), sheetOf('b', { name: 'Totals', order: 'a1' }));
        const before = bytes(book);
        expect(
            applyOps(book, [fields('b', { name: 'data', color: '#ff0000' }), fields('a', { color: '#00ff00' })]),
        ).toEqual([fields('a', { color: null })]);
        expect(book.sheets.get('b')?.records.fields).toEqual({ name: 'Totals', order: 'a1' });
        applyOps(book, [fields('a', { color: null })]);
        expect(bytes(book)).toBe(before);
    });

    test('a sheet takes its own name in another case, and a name no other sheet has', () => {
        const book = bookOf(sheetOf('a', { name: 'Data' }), sheetOf('b', { name: 'Totals', order: 'a1' }));
        expect(applyOps(book, [fields('a', { name: 'DATA' })])).toEqual([fields('a', { name: 'Data' })]);
        expect(applyOps(book, [fields('a', { name: 'DATA' })])).toEqual([]);
        expect(applyOps(book, [fields('b', { name: 'Data 2' })])).toEqual([fields('b', { name: 'Totals' })]);
        expect(book.sheets.get('a')?.records.fields.name).toBe('DATA');
    });

    test('the engine learns a sheet’s new name: a formula typed with it reads the sheet', () => {
        const cells: SheetContent['cells'] = [[0, 0, { f: "='Later'!R1C1+1" }]];
        const book = bookOf(sheetOf('a', {}, { cells }), sheetOf('b', { order: 'a1' }, { cells: [[0, 0, { v: 5 }]] }));
        bytes(book);
        expect(book.engine.valueOf('a', 0, 0)).toMatchObject({ text: '#REF!' });
        applyOps(book, [fields('b', { name: 'Later' })]);
        bytes(book);
        expect(book.engine.formulaOf('a', 0, 0)).toBe('=[b]!R1C1+1');
        expect(book.engine.valueOf('a', 0, 0)).toBe(6);
        // The engine holds the name, so it is in use for the next rename.
        expect(applyOps(book, [fields('a', { name: 'later' })])).toEqual([]);
    });

    test('the inverse of a rename that bound a formula puts the formula’s old text back', () => {
        const cells: SheetContent['cells'] = [[0, 0, { f: "='Later'!R1C1+1" }]];
        const book = bookOf(sheetOf('a', {}, { cells }), sheetOf('b', { order: 'a1' }));
        const before = bytes(book);
        applyOps(book, applyOps(book, [fields('b', { name: 'Later' })]));
        expect(bytes(book)).toBe(before);
    });

    test('a rename that would make a formula too long to store is refused before anything is written', () => {
        const id = 'b'.repeat(60);
        const cells: SheetContent['cells'] = [[0, 0, { f: `="${'a'.repeat(131_010)}"&'N'!R1C1` }]];
        const book = bookOf(sheetOf('a', {}, { cells }), sheetOf(id, { name: 'Second', order: 'a1' }));
        const before = bytes(book);
        expect(refusalOf(() => applyOps(book, [fields(id, { name: 'N', order: 'Zz', color: '#ff0000' })]))).toBe(
            'key-too-long',
        );
        expect(bytes(book)).toBe(before);
        expect(book.engine.sheetAt(0)).toBe('a');
    });

    test('an op on a sheet the book does not hold is skipped alone', () => {
        const book = bookOf(sheetOf('a'));
        const before = bytes(book);
        expect(applyOps(book, [fields('gone', { name: 'New' }), fields('a', { color: '#ff0000' })])).toEqual([
            fields('a', { color: null }),
        ]);
        applyOps(book, [
            { kind: 'record', sheet: 'gone', type: 'merge', id: 'm', set: { rect: [0, 0, 1, 1] }, whole: 1 },
        ]);
        applyOps(book, [fields('a', { color: null })]);
        expect(bytes(book)).toBe(before);
    });
});

describe('engine/book/apply-record — the records of a sheet', () => {
    const merge = (id: string, rect: [number, number, number, number], whole = true): RecordOp =>
        whole
            ? { kind: 'record', sheet: 'a', type: 'merge', id, set: { rect }, whole: 1 }
            : { kind: 'record', sheet: 'a', type: 'merge', id, set: { rect } };

    test('a merge over a live merge is refused, made or moved; a merge may take its own place', () => {
        const book = bookOf(
            sheetOf('a', {}, { records: { merge: { m: { rect: [0, 0, 1, 1] }, n: { rect: [5, 5, 6, 6] } } } }),
        );
        const before = bytes(book);
        expect(refusalOf(() => applyOps(book, [merge('x', [1, 1, 2, 2])]))).toBe('merge-overlap');
        expect(refusalOf(() => applyOps(book, [merge('n', [1, 1, 2, 2], false)]))).toBe('merge-overlap');
        expect(refusalOf(() => applyOps(book, [merge('n', [0, 0, 9, 9])]))).toBe('merge-overlap');
        expect(bytes(book)).toBe(before);
        expect(applyOps(book, [merge('m', [0, 0, 3, 3], false)])).toEqual([merge('m', [0, 0, 1, 1], false)]);
        expect(applyOps(book, [merge('x', [2, 4, 3, 5])])).toEqual([
            { kind: 'record', sheet: 'a', type: 'merge', id: 'x' },
        ]);
        expect(book.sheets.get('a')?.records.merge(3, 3)).toEqual([0, 0, 3, 3]);
    });

    test('a new filter takes the place of the live one, and the inverse brings it back before its columns', () => {
        const records: SheetContent['records'] = {
            filter: { f: { rect: [0, 0, 9, 3] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [[2, 3]] } },
        };
        const book = bookOf(sheetOf('a', {}, { records }));
        const before = bytes(book);
        const inverse = applyOps(book, [
            { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [1, 1, 5, 5] }, whole: 1 },
        ]);
        expect(book.content().sheets[0].records).toEqual({ filter: { g: { rect: [1, 1, 5, 5] } } });
        expect(inverse).toMatchObject([
            { type: 'filter', id: 'f' },
            { type: 'filterColumn', id: 'k' },
        ]);
        applyOps(book, inverse);
        expect(bytes(book)).toBe(before);
    });
});
