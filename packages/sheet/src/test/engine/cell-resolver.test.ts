import { describe, expect, test } from 'bun:test';
import { createArrayResolver } from '../../engine/cell-resolver';
import type { Cell, CellMatrix } from '../../engine/types';

const cellA: Cell = { v: 42, m: '42' };
const cellB: Cell = { v: 'hello', m: 'hello' };
const cellC: Cell = { v: true, m: 'TRUE' };

const sheetData: CellMatrix = [
    [cellA, cellB, null],
    [null, cellC, null],
    [null, null, null],
];

const sheets = [
    {
        id: 'sheet1',
        name: 'Sheet1',
        data: sheetData,
    },
    {
        id: 'sheet2',
        name: 'Sheet2',
        data: null,
    },
];

// ─── getCell ─────────────────────────────────────────────────────────────────

describe('engine/cell-resolver — getCell', () => {
    const resolver = createArrayResolver(sheets);

    test('returns cell at valid coordinates', () => {
        expect(resolver.getCell('sheet1', 0, 0)).toBe(cellA);
    });

    test('returns cell at another valid coordinate', () => {
        expect(resolver.getCell('sheet1', 0, 1)).toBe(cellB);
    });

    test('returns null for explicitly null cell', () => {
        expect(resolver.getCell('sheet1', 0, 2)).toBeNull();
    });

    test('returns null for out-of-bounds row', () => {
        expect(resolver.getCell('sheet1', 99, 0)).toBeNull();
    });

    test('returns null for out-of-bounds column', () => {
        expect(resolver.getCell('sheet1', 0, 99)).toBeNull();
    });

    test('returns null for unknown sheet', () => {
        expect(resolver.getCell('unknown', 0, 0)).toBeNull();
    });

    test('returns null when sheet data is null', () => {
        expect(resolver.getCell('sheet2', 0, 0)).toBeNull();
    });
});

// ─── getSheetIdByName ────────────────────────────────────────────────────────

describe('engine/cell-resolver — getSheetIdByName', () => {
    const resolver = createArrayResolver(sheets);

    test('finds sheet by name', () => {
        expect(resolver.getSheetIdByName('Sheet1')).toBe('sheet1');
    });

    test('finds second sheet by name', () => {
        expect(resolver.getSheetIdByName('Sheet2')).toBe('sheet2');
    });

    test('returns null for unknown name', () => {
        expect(resolver.getSheetIdByName('NoSuchSheet')).toBeNull();
    });

    test('finds a sheet whatever the case of its name, as Excel does', () => {
        expect(resolver.getSheetIdByName('sheet2')).toBe('sheet2');
        expect(resolver.getSheetIdByName('SHEET1')).toBe('sheet1');
    });

    test('in a workbook holding Data and data, each name finds its own sheet', () => {
        const twin = (id: string, name: string) => ({ ...sheets[0], id, name });
        const twins = createArrayResolver([twin('upper', 'Data'), twin('lower', 'data')]);
        expect([twins.getSheetIdByName('Data'), twins.getSheetIdByName('data')]).toEqual(['upper', 'lower']);
        expect(twins.getSheetIdByName('DATA')).toBe('upper');
    });
});

// ─── getSheetData ────────────────────────────────────────────────────────────

describe('engine/cell-resolver — getSheetData', () => {
    const resolver = createArrayResolver(sheets);

    test('returns data for valid sheet', () => {
        expect(resolver.getSheetData('sheet1')).toBe(sheetData);
    });

    test('returns null for sheet with no data', () => {
        expect(resolver.getSheetData('sheet2')).toBeNull();
    });

    test('returns null for unknown sheet', () => {
        expect(resolver.getSheetData('unknown')).toBeNull();
    });
});

// ─── hasSheet ────────────────────────────────────────────────────────────────

describe('engine/cell-resolver — hasSheet', () => {
    const resolver = createArrayResolver(sheets);

    test('a sheet with no matrix yet exists, an unknown id does not', () => {
        expect(resolver.hasSheet('sheet2')).toBe(true);
        expect(resolver.hasSheet('unknown')).toBe(false);
    });
});

// ─── live sheets ─────────────────────────────────────────────────────────────

describe('engine/cell-resolver — over live sheets', () => {
    test("a matrix that replaces a sheet's after the resolver was made is read", () => {
        const live = { id: 'live', name: 'Live', data: sheetData };
        const resolver = createArrayResolver([live]);
        expect(resolver.getSheetData('live')).toBe(sheetData);
        const replaced = [[{ v: 1 }]];
        live.data = replaced;
        expect(resolver.getSheetData('live')).toBe(replaced);
    });
});
