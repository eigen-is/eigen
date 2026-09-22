import { describe, expect, test } from 'bun:test';
import { SHEET_DEFAULT_COL_WIDTH, SHEET_DEFAULT_ROW_HEIGHT } from '@workspace/lib/sheets';
import type { Context } from '../../../state/context';
import { changeSheet } from '../../../state/modules/sheet';
import { contextFactory } from '../factories/context';

// The first frame after a switch paints whatever the switch's own recipe left in the context.
function twoSheetContext() {
    const ctx = contextFactory({ defaultrowlen: SHEET_DEFAULT_ROW_HEIGHT, defaultcollen: SHEET_DEFAULT_COL_WIDTH });
    const second = ctx.sheets![1];
    second.defaultRowHeight = 30;
    second.defaultColWidth = 100;
    second.config = { rowlen: { 1: 50 }, columnlen: { 2: 40 } };
    second.showGridLines = 0;
    return ctx as Context;
}

describe('changeSheet', () => {
    test('derives the target sheet defaults and geometry in the switch itself', () => {
        const ctx = twoSheetContext();
        changeSheet(ctx, 'id_2');
        expect(ctx.currentSheetId).toBe('id_2');
        expect(ctx.defaultrowlen).toBe(30);
        expect(ctx.defaultcollen).toBe(100);
        expect(ctx.showGridLines).toBe(false);
        expect(ctx.visibledatarow).toEqual([31, 82, 113, 144]);
        expect(ctx.visibledatacolumn).toEqual([101, 202, 243, 344]);
    });

    test('switching back restores the workbook defaults for a sheet without its own', () => {
        const ctx = twoSheetContext();
        changeSheet(ctx, 'id_2');
        changeSheet(ctx, 'id_1');
        expect(ctx.defaultrowlen).toBe(SHEET_DEFAULT_ROW_HEIGHT);
        expect(ctx.defaultcollen).toBe(SHEET_DEFAULT_COL_WIDTH);
        expect(ctx.showGridLines).toBe(true);
        const row = SHEET_DEFAULT_ROW_HEIGHT + 1;
        const col = SHEET_DEFAULT_COL_WIDTH + 1;
        expect(ctx.visibledatarow).toEqual([row, 2 * row, 3 * row, 4 * row]);
        expect(ctx.visibledatacolumn).toEqual([col, 2 * col, 3 * col, 4 * col]);
    });

    test('restores the scroll and selection recorded when the target sheet was left', () => {
        const ctx = twoSheetContext();
        ctx.scrollLeft = 120;
        ctx.scrollTop = 340;
        changeSheet(ctx, 'id_2');
        expect(ctx.scrollRequest).toEqual({ left: 0, top: 0 });
        changeSheet(ctx, 'id_1');
        expect(ctx.scrollRequest).toEqual({ left: 120, top: 340 });
        expect(ctx.selections?.[0]).toMatchObject({ row: [0, 0], column: [1, 1] });
    });
});
