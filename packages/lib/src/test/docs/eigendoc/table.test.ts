import { describe, expect, test } from 'bun:test';
import { columnFit, MIN_TABLE_COLUMN_PX } from '../../../docs/eigendoc';

describe('columnFit', () => {
    // One cell's widths, scaled by the factor of the whole table they are part of.
    test("a column scales by its whole table's factor, and keeps its width in a table that fits", () => {
        expect(columnFit(600, 1200)(400)).toBe(200);
        expect(columnFit(600, 500)(400)).toBe(400);
        expect(columnFit(600, 600)(400)).toBe(400);
        expect(columnFit(650, 1334)(4)).toBe(MIN_TABLE_COLUMN_PX);
    });

    test('a scaled column is floored to whole pixels', () => {
        const fit = columnFit(667, 1335);
        expect([fit(1000), fit(335)]).toEqual([499, 167]);
    });
});
