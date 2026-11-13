import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';

describe('the size of the grid', () => {
    // The formula package is a leaf and cannot import lib, so until lib's copy goes the two must not drift apart.
    test('is one fact in the formula package and in lib', () => {
        expect(GRID_ROWS).toBe(REFERENCE_ROW_COUNT);
        expect(GRID_COLUMNS).toBe(REFERENCE_COLUMN_COUNT);
    });
});
