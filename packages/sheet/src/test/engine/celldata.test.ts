import { describe, expect, test } from 'bun:test';
import type { Cell, CellWithRowAndCol } from '@workspace/lib/sheets';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { celldataToData, dataToCelldata } from '../../engine/celldata';

const cell = (v: string | number): Cell => ({ v, m: String(v), ct: { fa: 'General', t: 'g' } });

describe('dataToCelldata', () => {
    test('undefined data returns empty list', () => {
        expect(dataToCelldata(undefined)).toEqual([]);
    });

    test('empty matrix returns empty list', () => {
        expect(dataToCelldata([])).toEqual([]);
    });

    test('skips null cells', () => {
        const data = [
            [null, cell('a')],
            [cell('b'), null],
        ];
        expect(dataToCelldata(data)).toEqual([
            { r: 0, c: 1, v: cell('a') },
            { r: 1, c: 0, v: cell('b') },
        ]);
    });

    test('preserves cell value identity (no clone)', () => {
        const c = cell('a');
        const out = dataToCelldata([[c]]);
        expect(out[0]?.v).toBe(c);
    });
});

describe('celldataToData', () => {
    test('empty celldata expands to a 1x1 null matrix', () => {
        // Matches legacy behavior from state/api/common.ts: maxBy returns
        // undefined → bbox is 1x1, populated with null. Engine consumers
        // (rowcol, replay) expect a non-null matrix even for empty sheets.
        expect(celldataToData([], 1, 1)).toEqual([[null]]);
    });

    test('expands sparse celldata to bounding box', () => {
        const cells: CellWithRowAndCol[] = [
            { r: 0, c: 0, v: cell('a') },
            { r: 2, c: 1, v: cell('b') },
        ];
        const data = celldataToData(cells, 1, 1);
        expect(data.length).toBe(3);
        expect(data[0]?.length).toBe(2);
        expect(data[0]?.[0]?.v).toBe('a');
        expect(data[2]?.[1]?.v).toBe('b');
        expect(data[1]?.[0]).toBeNull();
        expect(data[1]?.[1]).toBeNull();
    });

    test('rowCount/colCount hints expand beyond bounding box', () => {
        const cells: CellWithRowAndCol[] = [{ r: 0, c: 0, v: cell('a') }];
        const data = celldataToData(cells, 5, 3);
        expect(data.length).toBe(5);
        expect(data[0]?.length).toBe(3);
        expect(data[4]?.[2]).toBeNull();
    });

    // A peer can store any number as a cell's row or column; the dense matrix has no slot for one that isn't an index.
    test('a cell at a negative or fractional row or column is dropped, and the rest read', () => {
        const cells: CellWithRowAndCol[] = [
            { r: -1, c: 0, v: cell('negative') },
            { r: 1.5, c: 0, v: cell('fraction') },
            { r: 0, c: -2, v: cell('left') },
            { r: 8, c: Number.NaN, v: cell('nan') },
            { r: 1, c: 1, v: cell('kept') },
        ];
        const data = celldataToData(cells, 1, 1);
        expect(data.length).toBe(2);
        expect(data[0]?.length).toBe(2);
        expect(data[1]?.[1]?.v).toBe('kept');
        expect(dataToCelldata(data).map(({ v }) => v?.v)).toEqual(['kept']);
    });

    // An index past the grid has no slot either: the matrix it asks for is wider than the grid or longer than an array.
    test('a cell past the last row or column of the grid is dropped, and the rest read', () => {
        const cells: CellWithRowAndCol[] = [
            { r: 2 ** 32, c: 0, v: cell('far') },
            { r: REFERENCE_ROW_COUNT, c: 0, v: cell('below') },
            { r: 0, c: REFERENCE_COLUMN_COUNT, v: cell('right') },
            { r: 1, c: 1, v: cell('kept') },
        ];
        const data = celldataToData(cells, 1, 1);
        expect(data.length).toBe(2);
        expect(data[0]?.length).toBe(2);
        expect(dataToCelldata(data).map(({ v }) => v?.v)).toEqual(['kept']);
    });

    test('hint smaller than bbox does not shrink', () => {
        const cells: CellWithRowAndCol[] = [{ r: 9, c: 9, v: cell('a') }];
        const data = celldataToData(cells, 2, 2);
        expect(data.length).toBe(10);
        expect(data[0]?.length).toBe(10);
    });
});

describe('round-trip', () => {
    test('celldata → data → celldata preserves cells', () => {
        const original: CellWithRowAndCol[] = [
            { r: 0, c: 0, v: cell('a') },
            { r: 5, c: 7, v: cell('b') },
        ];
        const data = celldataToData(original, 1, 1);
        const back = dataToCelldata(data);
        expect(back).toEqual(original);
    });

    test('data → celldata → data preserves non-null cells (rebuilt to bbox)', () => {
        const data = [
            [cell('a'), null, null],
            [null, null, cell('b')],
        ];
        const cells = dataToCelldata(data);
        const rebuilt = celldataToData(cells, 1, 1);
        expect(rebuilt[0]?.[0]?.v).toBe('a');
        expect(rebuilt[1]?.[2]?.v).toBe('b');
        expect(rebuilt[0]?.[2]).toBeNull();
    });
});
