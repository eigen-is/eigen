import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE } from '../../charts';
import { sheetChartBox } from '../../sheets/chart-box';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '../../sheets/defaults';

describe('sheetChartBox', () => {
    test('keeps a box on the grid as it is', () => {
        expect(sheetChartBox({ x: 120.5, y: 40, width: 400, height: 300 })).toEqual({
            x: 120.5,
            y: 40,
            width: 400,
            height: 300,
        });
    });

    test('a side past the max is the max, and one under a pixel a pixel', () => {
        expect(sheetChartBox({ x: 0, y: 0, width: 9.4e11, height: Number.POSITIVE_INFINITY })).toEqual({
            x: 0,
            y: 0,
            width: CHART_MAX_SIDE,
            height: CHART_MAX_SIDE,
        });
        expect(sheetChartBox({ x: 0, y: 0, width: 0, height: Number.NaN })).toMatchObject({ width: 1, height: 1 });
    });

    test("its corner lies on Excel's grid at the default track sizes", () => {
        expect(sheetChartBox({ x: 9.4e11, y: 9.4e11, width: 400, height: 300 })).toMatchObject({
            x: REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH,
            y: REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT,
        });
        expect(sheetChartBox({ x: -5, y: Number.NaN, width: 400, height: 300 })).toMatchObject({ x: 0, y: 0 });
    });
});
