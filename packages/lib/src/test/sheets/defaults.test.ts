import { describe, expect, test } from 'bun:test';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
    sheetColumnsWidth,
    sheetRowsHeight,
    sheetTrackAt,
} from '../../sheets/defaults';
import type { Sheet } from '../../sheets/types';

const sheet: Sheet = {
    name: 'Sheet1',
    defaultRowHeight: 25,
    config: { columnlen: { 0: 50, 2: 80 }, colhidden: { 1: 0 }, rowlen: { 1: 40 }, rowhidden: { 0: 0, 3: 0 } },
};

describe('sheetTrackAt', () => {
    test('finds the track a pixel lands in and the pixels into it, the inverse of the walk', () => {
        expect(sheetTrackAt(sheet, 'column', 0)).toEqual({ index: 0, offsetPx: 0 });
        expect(sheetTrackAt(sheet, 'column', 49.5)).toEqual({ index: 0, offsetPx: 49.5 });
        expect(sheetTrackAt(sheet, 'column', 70)).toEqual({ index: 2, offsetPx: 20 });
        expect(sheetTrackAt(sheet, 'column', 130 + SHEET_DEFAULT_COL_WIDTH + 7)).toEqual({ index: 4, offsetPx: 7 });
        expect(sheetTrackAt(sheet, 'row', 30)).toEqual({ index: 1, offsetPx: 30 });
        expect(sheetTrackAt(sheet, 'row', 52)).toEqual({ index: 2, offsetPx: 12 });
        for (const px of [0, 12, 49.5, 50, 129, 130, 777.25]) {
            const { index, offsetPx } = sheetTrackAt(sheet, 'column', px);
            expect(sheetColumnsWidth(sheet, 0, index - 1) + offsetPx).toBe(px);
        }
        for (const px of [0, 39, 40, 65, 66, 91, 1234]) {
            const { index, offsetPx } = sheetTrackAt(sheet, 'row', px);
            expect(sheetRowsHeight(sheet, 0, index - 1) + offsetPx).toBe(px);
        }
    });

    test('a track boundary starts the next shown track, past the hidden ones', () => {
        expect(sheetTrackAt(sheet, 'column', 50)).toEqual({ index: 2, offsetPx: 0 });
        expect(sheetTrackAt(sheet, 'row', 0)).toEqual({ index: 1, offsetPx: 0 });
        expect(sheetTrackAt(sheet, 'row', 65)).toEqual({ index: 4, offsetPx: 0 });
    });

    test('past the grid is the last track, the rest its offset', () => {
        const plain: Sheet = { name: 'Plain' };
        const width = REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH;
        expect(sheetTrackAt(plain, 'column', width + 10)).toEqual({
            index: REFERENCE_COLUMN_COUNT - 1,
            offsetPx: SHEET_DEFAULT_COL_WIDTH + 10,
        });
        expect(sheetTrackAt(plain, 'row', REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT)).toEqual({
            index: REFERENCE_ROW_COUNT - 1,
            offsetPx: SHEET_DEFAULT_ROW_HEIGHT,
        });
    });
});
