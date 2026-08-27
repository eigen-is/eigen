import { describe, expect, test } from 'bun:test';
import { enablePatches, produce, produceWithPatches } from 'immer';
import { generateAPIs } from '../../components/Workbook/api';
import { copySheet, hideSheet, showSheet } from '../../state/api/sheet';
import type { Context } from '../../state/context';
import { checkboxChange, insertCheckbox } from '../../state/modules/data-verification';
import { createFilter } from '../../state/modules/filter';
import { deleteRowCol, insertRowCol } from '../../state/modules/rowcol';
import { filterPatch, patchToOp } from '../../state/utils/patch';
import { contextFactory } from './factories/context';

enablePatches();

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

    test('insertCheckbox is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        insertCheckbox(ctx);
        expect(ctx.sheets[0].dataVerification).toBeUndefined();
    });

    test('checkboxChange is a no-op for viewers', () => {
        const ctx = contextFactory({ allowEdit: false }) as Context;
        ctx.sheets[0].dataVerification = { '0_0': { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' } };
        expect(checkboxChange(ctx, 0, 0)).toBe(false);
        expect(ctx.sheets[0].data![0][0]).toBeNull();
    });
});

// The permission guard must stop LOCAL viewer ops only — never the remote mirror.
// applyOp re-runs the reducer to re-derive the `data` shift while the metadata rides
// along as authoritative patches; if the guard skipped the shift but the patches still
// applied, a read-only collaborator's grid would diverge until the next snapshot.
describe('remote-op mirror (applyOp) still applies to viewers', () => {
    // Build the wire ops an editor would emit for a row insert/delete, then apply the
    // exact same ops through the real applyOp on a read-only viewer context.
    function mirrorToViewer(recipe: (ctx: Context) => void, options: Parameters<typeof patchToOp>[2]) {
        const editorNext = produceWithPatches(contextFactory({ allowEdit: true }) as Context, recipe);
        const [next, patches] = editorNext;
        const ops = patchToOp(next, filterPatch(patches), options);

        let vctx = contextFactory({ allowEdit: false }) as Context;
        const setContext = (r: (c: Context) => void) => {
            vctx = produce(vctx, r);
        };
        // applyOp only reads `settings` on the addSheet branch, not for row/col ops.
        // biome-ignore lint/suspicious/noExplicitAny: minimal settings stub for this path
        const settings = {} as any;
        const workbook = generateAPIs(
            vctx,
            setContext,
            () => {},
            () => {},
            settings,
        );
        workbook.applyOp(ops);
        return { vctx, next };
    }

    test('a remote insert row mirrors to a read-only viewer', () => {
        const op = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        const { vctx, next } = mirrorToViewer((ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(vctx.sheets[0].data).toEqual(next.sheets[0].data);
        expect(vctx.sheets[0].data!.length).toBe(5);
    });

    test('a remote delete row mirrors to a read-only viewer', () => {
        const op = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        const { vctx, next } = mirrorToViewer((ctx) => deleteRowCol(ctx, op), { deleteRowColOp: op });
        expect(vctx.sheets[0].data).toEqual(next.sheets[0].data);
        expect(vctx.sheets[0].data!.length).toBe(3);
    });
});
