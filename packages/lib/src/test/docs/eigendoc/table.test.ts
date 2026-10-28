import { describe, expect, test } from 'bun:test';
import { columnFit, fitColumnWidths, MIN_TABLE_COLUMN_PX } from '../../../docs/eigendoc';

describe('fitColumnWidths', () => {
    test('a table that fits keeps its widths', () => {
        const widths = [200, 300, 100];
        expect(fitColumnWidths(widths, 600)).toEqual(widths);
        expect(fitColumnWidths(widths, 900)).toEqual(widths);
    });

    test('a wider table shrinks every column by one factor, floored to whole pixels', () => {
        expect(fitColumnWidths([400, 800], 600)).toEqual([200, 400]);
        expect(fitColumnWidths([1000, 335], 667)).toEqual([499, 167]);
    });

    test('no column shrinks below the floor', () => {
        expect(fitColumnWidths([1300, 30, 4], 650)).toEqual([633, MIN_TABLE_COLUMN_PX, MIN_TABLE_COLUMN_PX]);
    });
});

describe('columnFit', () => {
    // One cell's widths, scaled by the factor of the whole table they are part of.
    test("a column scales by its whole table's factor, and keeps its width in a table that fits", () => {
        expect(columnFit(600, 1200)(400)).toBe(200);
        expect(columnFit(600, 500)(400)).toBe(400);
        expect(columnFit(650, 1334)(4)).toBe(MIN_TABLE_COLUMN_PX);
    });
});
