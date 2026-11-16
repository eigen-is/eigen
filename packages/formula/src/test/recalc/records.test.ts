import { describe, expect, test } from 'bun:test';
import { Records } from '../../recalc/records';
import { Column } from '../../store/column';
import type { Reference } from '../../values/value';
import { ValueType } from '../../values/value';

// A record is one box per sheet its formula resolved into, so its size is bounded by the sheets and not by how
// many areas the formula resolved. The numbers a record holds are counted where the index reads them.

function area(sheet: number, top: number, left: number, bottom: number, right: number): Reference {
    return { type: ValueType.Reference, sheet, top, left, bottom, right, next: null };
}

function held(records: Records, column: Column, row: number): readonly number[] {
    return records.held.get(column)?.get(row) ?? [];
}

describe('a record is bounded by the sheets its formula resolved into', () => {
    test('100,000 areas of one sheet, as a call lifted over a column resolves, are one box', () => {
        const records = new Records(false);
        const column = new Column(1);
        records.start(0);
        for (let row = 0; row < 100_000; row += 1) records.add(0, area(0, row, row % 2, row, row % 2));
        records.end(0, column, 0);
        expect(held(records, column, 0)).toEqual([0, 0, 0, 99_999, 1]);
    });

    test('areas of two sheets are a box each, in whatever order they come', () => {
        const records = new Records(false);
        const column = new Column(1);
        records.start(0);
        for (let i = 0; i < 1000; i += 1) records.add(0, area(i % 2, 10 + i, 3, 20 + i, 4));
        records.end(0, column, 0);
        expect(held(records, column, 0)).toEqual([0, 10, 3, 1018, 4, 1, 11, 3, 1019, 4]);
    });

    test('a formula that resolves nothing holds no record, and one that ran again holds only what it then resolved', () => {
        const records = new Records(false);
        const column = new Column(2);
        records.start(0);
        records.end(0, column, 0);
        expect(records.held.get(column)?.has(0) ?? false).toBe(false);
        expect(records.changed).toBe(false);
        records.start(0);
        records.add(0, area(0, 5, 5, 9, 9));
        records.add(0, area(0, 1, 1, 2, 2));
        records.end(0, column, 1);
        expect(held(records, column, 1)).toEqual([0, 1, 1, 9, 9]);
        expect(records.changed).toBe(true);
        records.changed = false;
        records.start(0);
        records.add(0, area(0, 1, 1, 2, 2));
        records.end(0, column, 1);
        expect(held(records, column, 1)).toEqual([0, 1, 1, 2, 2]);
        expect(records.changed).toBe(true);
        records.changed = false;
        records.start(0);
        records.add(0, area(0, 1, 1, 2, 2));
        records.end(0, column, 1);
        expect(records.changed).toBe(false);
        records.start(0);
        records.end(0, column, 1);
        expect(records.held.get(column)?.has(1) ?? false).toBe(false);
        expect(records.changed).toBe(true);
    });
});
