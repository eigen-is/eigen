import { describe, expect, test } from 'bun:test';
import type { Cell, CellWithRowAndCol } from '@workspace/lib/sheets';
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
        // Matches legacy behaviour from state/api/common.ts: maxBy returns
        // undefined → bbox is 1x1, populated with null. Engine consumers
        // (rowcol, replay) expect a non-null matrix even for empty sheets.
        expect(celldataToData([])).toEqual([[null]]);
    });

    test('expands sparse celldata to bounding box', () => {
        const cells: CellWithRowAndCol[] = [
            { r: 0, c: 0, v: cell('a') },
            { r: 2, c: 1, v: cell('b') },
        ];
        const data = celldataToData(cells)!;
        expect(data.length).toBe(3);
        expect(data[0]?.length).toBe(2);
        expect(data[0]?.[0]?.v).toBe('a');
        expect(data[2]?.[1]?.v).toBe('b');
        expect(data[1]?.[0]).toBeNull();
        expect(data[1]?.[1]).toBeNull();
    });

    test('rowCount/colCount hints expand beyond bounding box', () => {
        const cells: CellWithRowAndCol[] = [{ r: 0, c: 0, v: cell('a') }];
        const data = celldataToData(cells, 5, 3)!;
        expect(data.length).toBe(5);
        expect(data[0]?.length).toBe(3);
        expect(data[4]?.[2]).toBeNull();
    });

    test('hint smaller than bbox does not shrink', () => {
        const cells: CellWithRowAndCol[] = [{ r: 9, c: 9, v: cell('a') }];
        const data = celldataToData(cells, 2, 2)!;
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
        const data = celldataToData(original)!;
        const back = dataToCelldata(data);
        expect(back).toEqual(original);
    });

    test('data → celldata → data preserves non-null cells (rebuilt to bbox)', () => {
        const data = [
            [cell('a'), null, null],
            [null, null, cell('b')],
        ];
        const cells = dataToCelldata(data);
        const rebuilt = celldataToData(cells)!;
        expect(rebuilt[0]?.[0]?.v).toBe('a');
        expect(rebuilt[1]?.[2]?.v).toBe('b');
        expect(rebuilt[0]?.[2]).toBeNull();
    });
});
