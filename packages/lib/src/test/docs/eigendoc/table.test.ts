import { describe, expect, test } from 'bun:test';
import { columnFit, isWidth, MIN_TABLE_COLUMN_PX } from '../../../docs/eigendoc';

describe('columnFit', () => {
    // One cell's widths, scaled by the factor of the whole table they are part of.
    test("a column scales by its whole table's factor, and keeps its width in a table that fits", () => {
        expect(columnFit(600, 1200)(400)).toBe(200);
        expect(columnFit(600, 500)(400)).toBe(400);
        expect(columnFit(600, 600)(400)).toBe(400);
        expect(columnFit(650, 1334)(4)).toBe(MIN_TABLE_COLUMN_PX);
    });

    // 63 columns at the 25 px floor are 1575 px, wider than A4's 642.5 px column; a floor of 1 fits them in it.
    test('a floor of 1 scales a table of many columns into the column', () => {
        expect(columnFit(642.5, 1575)(25)).toBe(MIN_TABLE_COLUMN_PX);
        expect(columnFit(642.5, 1575, 1)(25)).toBe(10);
        expect(columnFit(650, 1334, 1)(1)).toBe(1);
    });

    test('a scaled column is floored to whole pixels', () => {
        const fit = columnFit(667, 1335);
        expect([fit(1000), fit(335)]).toEqual([499, 167]);
    });
});

// A peer can store any JSON as a column's width.
describe('isWidth', () => {
    test('a width is a positive, finite number', () => {
        expect([100, 0.5].every(isWidth)).toBe(true);
        expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100', null].some(isWidth)).toBe(false);
    });
});
