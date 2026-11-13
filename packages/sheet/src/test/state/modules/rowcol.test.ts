import { describe, expect, test } from 'bun:test';
import { MAX_GRID_SLOTS, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../../engine/defaults';
import type { Context } from '../../../state/context';
import { tryInsertRowCol } from '../../../state/events/rowcol';
import {
    deleteRowCol,
    hideSelectedRowCol,
    insertRowCol,
    isSelectionOnHiddenRowCol,
    moveCountPastHiddenRowCol,
    ONE_AREA_ONLY,
    showSelectedRowCol,
} from '../../../state/modules/rowcol';
import { moveHighlightCell } from '../../../state/modules/selection';
import { receive } from '../factories/collab';
import { contextFactory, workbookContextFactory } from '../factories/context';

describe('the filter follows a row or column op', () => {
    const filtered = (): Context =>
        contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: {},
                    data: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null)),
                    filterRange: { row: [0, 3], column: [0, 3] },
                    filter: {
                        1: { rowhidden: { 2: 0 }, optionstate: true, str: 0, edr: 3, cindex: 1, stc: 0, edc: 3 },
                    },
                },
            ],
        }) as Context;
    const entry = { optionstate: true, cindex: 1, stc: 0, edc: 3 };

    test('a row insert above moves the filter and its hidden rows down', () => {
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => insertRowCol(ctx, op, false)).sheets;
        expect(sheet.filterRange).toEqual({ row: [2, 5], column: [0, 3] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 4: 0 }, str: 2, edr: 5 } });
        expect(sheet.config?.rowhidden).toEqual({ 4: 0 });
    });

    test('a column insert inside widens the filter', () => {
        const op = { type: 'column', index: 1, count: 1, direction: 'rightbottom', id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => insertRowCol(ctx, op, false)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 3], column: [0, 4] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 2: 0 }, str: 0, edr: 3, edc: 4 } });
    });

    test('a row delete inside shrinks the filter and moves its hidden rows up', () => {
        const op = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 2], column: [0, 3] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 1: 0 }, str: 0, edr: 2 } });
    });

    test('a row delete of every hidden row keeps the criteria', () => {
        const op = { type: 'row', start: 2, end: 2, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 2], column: [0, 3] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: {}, str: 0, edr: 2 } });
    });

    test('a column delete of a filtered column takes its criteria and keeps the filter', () => {
        const op = { type: 'column', start: 1, end: 1, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 3], column: [0, 2] });
        expect(sheet.filter).toEqual({});
    });

    test('a row delete of the header row drops the filter', () => {
        const op = { type: 'row', start: 0, end: 1, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toBeUndefined();
        expect(sheet.filter).toBeUndefined();
    });

    test('a column delete at the left edge moves the filter column left', () => {
        const op = { type: 'column', start: 0, end: 0, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 3], column: [0, 2] });
        expect(sheet.filter).toEqual({ 0: { ...entry, rowhidden: { 2: 0 }, str: 0, edr: 3, cindex: 0, edc: 2 } });
    });

    // Legacy data and a peer's op can carry a filter entry that hides no rows and has no rowhidden map at all.
    test('a filter entry without hidden rows survives a row insert, a column delete and a row delete', () => {
        const bare = produce(filtered(), (ctx: Context) => {
            ctx.sheets[0].filter = { 1: { optionstate: true, str: 0, edr: 3, cindex: 1, stc: 0, edc: 3 } };
        });
        const insert = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        const [inserted] = produce(bare, (ctx: Context) => insertRowCol(ctx, insert, false)).sheets;
        expect(inserted.filterRange).toEqual({ row: [1, 4], column: [0, 3] });
        expect(inserted.filter).toEqual({ 1: { ...entry, rowhidden: {}, str: 1, edr: 4 } });
        const remove = { type: 'column', start: 0, end: 0, id: 'id_1' } as const;
        const [deleted] = produce(bare, (ctx: Context) => deleteRowCol(ctx, remove)).sheets;
        expect(deleted.filterRange).toEqual({ row: [0, 3], column: [0, 2] });
        expect(deleted.filter).toEqual({ 0: { ...entry, str: 0, edr: 3, cindex: 0, edc: 2 } });
        expect(deleted.config?.rowhidden).toEqual({});
        const removeRow = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        const [shrunk] = produce(bare, (ctx: Context) => deleteRowCol(ctx, removeRow)).sheets;
        expect(shrunk.filterRange).toEqual({ row: [0, 2], column: [0, 3] });
        expect(shrunk.filter).toEqual({ 1: { ...entry, rowhidden: {}, str: 0, edr: 2 } });
        const below = { type: 'row', start: 5, end: 5, id: 'id_1' } as const;
        const [kept] = produce(bare, (ctx: Context) => deleteRowCol(ctx, below)).sheets;
        expect(kept.filter).toEqual({ 1: { ...entry, rowhidden: {}, str: 0, edr: 3 } });
    });
});

describe('hidden rows and columns under the selection', () => {
    const hiddenSheet = (selections: Context['selections']): Context => ({
        ...(contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: { rowhidden: { 2: 0, 3: 0 }, colhidden: { 4: 0 } },
                    data: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null)),
                },
            ],
        }) as Context),
        selections,
    });
    const at = (row: number, column: number) => [{ row: [row, row], column: [column, column] }];

    test('an arrow key steps over a run of hidden rows or columns', () => {
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(1, 0)), 'ArrowDown')).toBe(3);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(4, 0)), 'ArrowUp')).toBe(3);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(4, 0)), 'ArrowDown')).toBe(1);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(0, 3)), 'ArrowRight')).toBe(2);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(0, 5)), 'ArrowLeft')).toBe(2);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(0, 3)), 'ArrowLeft')).toBe(1);
        expect(moveCountPastHiddenRowCol(hiddenSheet(at(1, 0)), 'Enter')).toBe(1);
        expect(moveCountPastHiddenRowCol(hiddenSheet(undefined), 'ArrowDown')).toBe(0);
    });

    test('a selection that starts on a hidden row or column is on hidden ones', () => {
        expect(isSelectionOnHiddenRowCol(hiddenSheet(at(2, 0)))).toBe(true);
        expect(isSelectionOnHiddenRowCol(hiddenSheet(at(0, 4)))).toBe(true);
        expect(isSelectionOnHiddenRowCol(hiddenSheet(at(1, 1)))).toBe(false);
        expect(isSelectionOnHiddenRowCol(hiddenSheet(undefined))).toBe(false);
    });

    test('hiding moves the selection off the hidden rows, up when the rows below are hidden or gone', () => {
        const down = produce(hiddenSheet(at(0, 0)), (ctx: Context) => {
            hideSelectedRowCol(ctx, 'row');
        });
        expect(down.sheets[0].config?.rowhidden).toEqual({ 0: 0, 2: 0, 3: 0 });
        expect(down.selections?.[0].row).toEqual([1, 1]);
        const up = produce(hiddenSheet(at(1, 0)), (ctx: Context) => {
            hideSelectedRowCol(ctx, 'row');
        });
        expect(up.selections?.[0].row).toEqual([0, 0]);
        const last = produce(hiddenSheet(at(0, 5)), (ctx: Context) => {
            hideSelectedRowCol(ctx, 'column');
        });
        expect(last.sheets[0].config?.colhidden).toEqual({ 4: 0, 5: 0 });
        expect(last.selections?.[0].column).toEqual([4, 4]);
    });

    test('an insert past a limit leaves the notice that names it', () => {
        const refused = (rows: number, columns: number, type: 'row' | 'column') => {
            const ctx = hiddenSheet(at(0, 0));
            // The rows share one array, which a refused insert never writes.
            ctx.sheets[0].data = new Array(rows).fill(new Array(columns).fill(null));
            tryInsertRowCol(ctx, { type, index: 0, count: 1, direction: 'lefttop', id: ctx.currentSheetId });
            expect(ctx.sheets[0].data).toHaveLength(rows);
            return ctx.warnDialog;
        };
        expect(refused(MAX_SHEET_ROW_COUNT, 1, 'row')).toBe('10000 row limit exceeded');
        expect(refused(1, MAX_SHEET_COLUMN_COUNT, 'column')).toBe('1000 column limit exceeded');
        const widest = Math.floor(MAX_GRID_SLOTS / REFERENCE_ROW_COUNT);
        expect(refused(REFERENCE_ROW_COUNT, widest, 'column')).toBe('110,000,000 cell limit exceeded');
    });

    test('hiding or showing refuses more than one selection', () => {
        for (const write of [hideSelectedRowCol, showSelectedRowCol]) {
            const two = hiddenSheet([...at(0, 0), ...at(1, 1)]);
            const before = two.sheets[0].config?.rowhidden;
            write(two, 'row');
            expect(two.warnDialog).toBe(ONE_AREA_ONLY);
            expect(two.sheets[0].config?.rowhidden).toEqual(before);
        }
    });

    // A peer's replace can set the hidden map to any value. The cell editors ask on every selection change, so a
    // throw there would crash them.
    test('a hidden map that is no map counts as nothing hidden, and a hide starts a new map', () => {
        const forged = receive(hiddenSheet(at(1, 0)), [
            { op: 'replace', id: 'id_1', path: ['config', 'rowhidden'], value: 5 },
        ]);
        expect(isSelectionOnHiddenRowCol(forged)).toBe(false);
        expect(moveCountPastHiddenRowCol(forged, 'ArrowDown')).toBe(1);
        const hid = produce(forged, (ctx: Context) => {
            hideSelectedRowCol(ctx, 'row');
        });
        expect(hid.sheets[0].config?.rowhidden).toEqual({ 1: 0 });
    });

    test('showing unhides the selected rows or columns', () => {
        const rows = produce(hiddenSheet([{ row: [1, 3], column: [0, 0] }]), (ctx: Context) => {
            showSelectedRowCol(ctx, 'row');
        });
        expect(rows.sheets[0].config?.rowhidden).toEqual({});
        const columns = produce(hiddenSheet(at(0, 4)), (ctx: Context) => {
            showSelectedRowCol(ctx, 'column');
        });
        expect(columns.sheets[0].config?.colhidden).toEqual({});
    });
});

// A tab's own delete leaves a cursor, so the name box, the status bar and the arrow keys keep working.
describe("a tab's own delete", () => {
    const selected = (selection: NonNullable<Context['selections']>[number]): Context =>
        workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: {},
                    data: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null)),
                },
            ],
            selections: [selection],
        });
    const cell = (r: number, c: number) => ({ row: [r, r], column: [c, c], row_focus: r, column_focus: c });
    const remove = (ctx: Context, type: 'row' | 'column', start: number, end = start) =>
        produce(ctx, (draft: Context) => deleteRowCol(draft, { type, start, end, id: 'id_1' }));

    test('of the selected row lands on the row that took its place', () => {
        expect(remove(selected(cell(2, 3)), 'row', 2).selections).toEqual([cell(2, 3)]);
    });

    test('of the selected column lands on the column that took its place', () => {
        expect(remove(selected(cell(2, 3)), 'column', 3).selections).toEqual([cell(2, 3)]);
    });

    test('of the last row or column lands on the one before it', () => {
        expect(remove(selected(cell(5, 3)), 'row', 5).selections).toEqual([cell(4, 3)]);
        expect(remove(selected(cell(2, 5)), 'column', 5).selections).toEqual([cell(2, 4)]);
    });

    test('of several selected rows lands on one, and a header selection stays one', () => {
        const header = { row: [1, 3], column: [0, 5], row_focus: 1, column_focus: 0, row_select: true };
        expect(remove(selected(header), 'row', 1, 3).selections).toEqual([{ ...header, row: [1, 1] }]);
    });

    test('of the rows to the end of the grid lands on the new last one', () => {
        expect(remove(selected(cell(4, 1)), 'row', 3, 5).selections).toEqual([cell(2, 1)]);
    });

    test('of part of a selection shrinks it', () => {
        const range = { row: [1, 4], column: [3, 4], row_focus: 1, column_focus: 3 };
        expect(remove(selected(range), 'row', 2, 3).selections).toEqual([{ ...range, row: [1, 2] }]);
    });

    test('above a selection moves it with its cells', () => {
        expect(remove(selected(cell(4, 1)), 'row', 0).selections).toEqual([cell(3, 1)]);
    });

    test('leaves a selection the arrow keys can move', () => {
        const moved = produce(remove(selected(cell(2, 3)), 'row', 2), (draft: Context) => {
            moveHighlightCell(draft, 'down', 1, 'rangeOfSelect');
        });
        expect(moved.selections?.[0].row).toEqual([3, 3]);
    });
});
