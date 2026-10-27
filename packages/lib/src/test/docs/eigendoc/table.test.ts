import { describe, expect, test } from 'bun:test';
import { fitColumnWidths, MIN_TABLE_COLUMN_PX } from '../../../docs/eigendoc';

describe('fitColumnWidths', () => {
    test('a table that fits keeps its widths', () => {
        const widths = [200, 300, 100];
        expect(fitColumnWidths(widths, 600)).toBe(widths);
        expect(fitColumnWidths(widths, 900)).toBe(widths);
    });

    test('a wider table shrinks every column by one factor, floored to whole pixels', () => {
        expect(fitColumnWidths([400, 800], 600)).toEqual([200, 400]);
        expect(fitColumnWidths([1000, 335], 667)).toEqual([499, 167]);
    });

    test('no column shrinks below the floor', () => {
        expect(fitColumnWidths([1300, 30, 4], 650)).toEqual([633, MIN_TABLE_COLUMN_PX, MIN_TABLE_COLUMN_PX]);
    });

    // One cell's widths, scaled by the factor of the whole table they are part of.
    test('a part of a table scales by the whole table factor', () => {
        expect(fitColumnWidths([400], 600, 1200)).toEqual([200]);
        expect(fitColumnWidths([400], 600, 500)).toEqual([400]);
    });
});
