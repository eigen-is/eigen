import { describe, expect, test } from 'bun:test';
import { copySheet, hideSheet, showSheet } from '../api/sheet';
import type { Context } from '../context';
import { createFilter } from '../modules/filter';
import { deleteRowCol, insertRowCol } from '../modules/rowcol';
import { contextFactory } from './factories/context';

// A viewer (allowEdit === false) must not mutate the workbook through any
// state-layer choke point, whichever UI surface reached it. The menus gate for
// editors, but the state layer is the last line of defense — a future ungated
// caller must still be a no-op for viewers.
describe('read-only (allowEdit === false) state guards', () => {
    test('insertRowCol is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        const rows = ctx.sheets[0].data!.length;
        insertRowCol(ctx, { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' });
        expect(ctx.sheets[0].data!.length).toBe(rows);
    });

    test('deleteRowCol is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        const rows = ctx.sheets[0].data!.length;
        deleteRowCol(ctx, { type: 'row', start: 0, end: 0, id: 'id_1' });
        expect(ctx.sheets[0].data!.length).toBe(rows);
    });

    test('hideSheet is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        hideSheet(ctx, 'id_2');
        expect(ctx.sheets[1].hide).toBeUndefined();
    });

    test('showSheet is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        ctx.sheets[1].hide = 1;
        showSheet(ctx, 'id_2');
        expect(ctx.sheets[1].hide).toBe(1);
    });

    test('copySheet is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        const count = ctx.sheets.length;
        copySheet(ctx, 'id_1');
        expect(ctx.sheets.length).toBe(count);
    });

    test('createFilter is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        createFilter(ctx);
        expect(ctx.filterRange).toBeUndefined();
    });

    test('createFilter still creates a filter for editors', () => {
        const ctx = contextFactory({ allowEdit: true }) as Context;
        createFilter(ctx);
        expect(ctx.filterRange).toBeDefined();
    });
});
