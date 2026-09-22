import { describe, expect, test } from 'bun:test';
import { SHEET_DEFAULT_COL_WIDTH, SHEET_DEFAULT_ROW_HEIGHT } from '@workspace/lib/sheets';
import { setSelection } from '../../../state/api/range';
import { hideSheet } from '../../../state/api/sheet';
import { type Context, firstVisibleSheetId, initSheetIndex } from '../../../state/context';
import { changeSheet, deleteSheet, settleCurrentSheet } from '../../../state/modules/sheet';
import { contextFactory } from '../factories/context';

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

    test('restores the selection a sheet stores while it is not current', () => {
        const ctx = twoSheetContext();
        setSelection(ctx, [{ row: [2, 3], column: [2, 2] }], { id: 'id_2' });
        changeSheet(ctx, 'id_2');
        expect(ctx.selections?.[0]).toMatchObject({ row: [2, 3], column: [2, 2] });
    });

    test('refuses a hidden sheet', () => {
        const ctx = twoSheetContext();
        ctx.sheets[1].hide = 1;
        changeSheet(ctx, 'id_2');
        expect(ctx.currentSheetId).toBe('id_1');
    });

    test('a forced switch skips the veto hook', () => {
        const ctx = twoSheetContext();
        ctx.hooks = { beforeActivateSheet: () => false };
        changeSheet(ctx, 'id_2');
        expect(ctx.currentSheetId).toBe('id_1');
        changeSheet(ctx, 'id_2', true);
        expect(ctx.currentSheetId).toBe('id_2');
    });

    test('closes the cell editor and any formula range selection', () => {
        const ctx = twoSheetContext();
        ctx.editingCellPosition = [1, 1];
        ctx.formulaCache.rangestart = true;
        ctx.formulaRangeSelect = { rangeIndex: 0, left: 0, top: 0, width: 10, height: 10 };
        changeSheet(ctx, 'id_2', true);
        expect(ctx.editingCellPosition).toEqual([]);
        expect(ctx.formulaCache.rangestart).toBe(false);
        expect(ctx.formulaRangeSelect).toBeUndefined();
    });
});

// Tab order is `order`, not array position; C is hidden.
function tabOrderContext() {
    const ctx = twoSheetContext();
    const data = () => [
        [null, null],
        [null, null],
    ];
    ctx.sheets = [
        { name: 'A', id: 'a', order: 2, data: data(), config: {} },
        { name: 'B', id: 'b', order: 0, data: data(), config: {} },
        { name: 'C', id: 'c', order: 1, hide: 1, data: data(), config: {} },
        { name: 'D', id: 'd', order: 3, data: data(), config: {}, defaultRowHeight: 30 },
    ];
    ctx.currentSheetId = 'a';
    return ctx;
}

describe('firstVisibleSheetId', () => {
    test('is the first visible sheet in tab order', () => {
        const ctx = tabOrderContext();
        expect(firstVisibleSheetId(ctx)).toBe('b');
        expect(firstVisibleSheetId(ctx, 'b')).toBe('a');
    });

    test('initSheetIndex opens the first visible sheet in tab order when none is active', () => {
        const ctx = tabOrderContext();
        ctx.currentSheetId = '';
        initSheetIndex(ctx);
        expect(ctx.currentSheetId).toBe('b');
    });
});

describe('leaving a sheet that goes away', () => {
    test('hiding the current sheet switches to the first visible sheet and restores its view', () => {
        const ctx = tabOrderContext();
        changeSheet(ctx, 'b');
        ctx.scrollTop = 500;
        changeSheet(ctx, 'd');
        changeSheet(ctx, 'a');
        ctx.hooks = { beforeActivateSheet: () => false };
        hideSheet(ctx, 'a');
        expect(ctx.sheets[0].hide).toBe(1);
        expect(ctx.currentSheetId).toBe('b');
        expect(ctx.scrollRequest).toEqual({ left: 0, top: 500 });
        expect(ctx.visibledatarow).toEqual([SHEET_DEFAULT_ROW_HEIGHT + 1, 2 * (SHEET_DEFAULT_ROW_HEIGHT + 1)]);
    });

    test('hiding another sheet leaves the current sheet alone', () => {
        const ctx = tabOrderContext();
        changeSheet(ctx, 'd');
        hideSheet(ctx, 'a');
        expect(ctx.sheets[0].hide).toBe(1);
        expect(ctx.currentSheetId).toBe('d');
    });

    test('deleting the current sheet switches to the first visible sheet in tab order', () => {
        const ctx = tabOrderContext();
        ctx.hooks = { beforeActivateSheet: () => false };
        changeSheet(ctx, 'd', true);
        deleteSheet(ctx, 'd');
        expect(ctx.currentSheetId).toBe('b');
        expect(ctx.defaultrowlen).toBe(SHEET_DEFAULT_ROW_HEIGHT);
    });

    test('a redone hide of the current sheet leaves it for the first visible sheet', () => {
        const ctx = tabOrderContext();
        ctx.sheets[0].hide = 1;
        settleCurrentSheet(ctx);
        expect(ctx.currentSheetId).toBe('b');
    });

    test('an undone add of the current sheet leaves it for the first visible sheet', () => {
        const ctx = tabOrderContext();
        ctx.sheets.splice(0, 1);
        settleCurrentSheet(ctx);
        expect(ctx.currentSheetId).toBe('b');
    });

    test('a visible current sheet stays current', () => {
        const ctx = tabOrderContext();
        settleCurrentSheet(ctx);
        expect(ctx.currentSheetId).toBe('a');
    });

    test('a peer deleting a sheet applies for a viewer', () => {
        const ctx = tabOrderContext();
        ctx.allowEdit = false;
        deleteSheet(ctx, 'a');
        expect(ctx.sheets.map((sheet) => sheet.id)).toContain('a');
        deleteSheet(ctx, 'a', true);
        expect(ctx.sheets.map((sheet) => sheet.id)).not.toContain('a');
        expect(ctx.currentSheetId).toBe('b');
    });
});
