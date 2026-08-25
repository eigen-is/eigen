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
        calculationChain: [{ r: 0, c: 0, id: 'sheet1' }],
        dynamicArrayCompute: [],
    },
    {
        id: 'sheet2',
        name: 'Sheet2',
        data: null,
        calculationChain: [],
        dynamicArrayCompute: [],
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

// ─── getSheets ───────────────────────────────────────────────────────────────

describe('engine/cell-resolver — getSheets', () => {
    const resolver = createArrayResolver(sheets);

    test('returns all sheets', () => {
        const result = resolver.getSheets();
        expect(result).toHaveLength(2);
    });

    test('includes id and name for each sheet', () => {
        const result = resolver.getSheets();
        expect(result[0].id).toBe('sheet1');
        expect(result[0].name).toBe('Sheet1');
        expect(result[1].id).toBe('sheet2');
        expect(result[1].name).toBe('Sheet2');
    });

    test('includes calculationChain', () => {
        const result = resolver.getSheets();
        expect(result[0].calculationChain).toEqual([{ r: 0, c: 0, id: 'sheet1' }]);
        expect(result[1].calculationChain).toEqual([]);
    });

    test('includes dynamicArrayCompute', () => {
        const result = resolver.getSheets();
        expect(result[0].dynamicArrayCompute).toEqual([]);
    });

    test('returns empty array when no sheets provided', () => {
        const emptyResolver = createArrayResolver([]);
        expect(emptyResolver.getSheets()).toEqual([]);
    });
});
