// A resize writes the current sheet's config, and filterPatch keeps only the `sheets[*]`
// half of a recipe's patches, so the write has to land there or it neither syncs nor
// undoes. These pin the round trip on the drag path the bug was reported on, the api
// path, and the remote-op path, plus the granularity of the patch each one emits — a
// whole-config replace round-trips just as well on one client, so only the patch path
// tells the two apart. The drag handler needs a real DOM, so happy-dom is installed at
// module scope the way events/mouse-cell.test.ts does.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import { setColumnWidth, setRowHeight } from '../../../state/api/rowcol';
import type { Context } from '../../../state/context';
import { handleOverlayMouseUp } from '../../../state/events/mouse-drag';
import type { Settings } from '../../../state/settings';
import type { GlobalCache, Op } from '../../../state/types';
import { filterPatch, opToPatch } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

function resizeContext(): Context {
    const config = { rowlen: { 2: 40 }, columnlen: { 2: 100 } };
    const ctx = contextFactory({ config }) as Context;
    ctx.rowHeaderWidth = 46;
    ctx.columnHeaderHeight = 20;
    ctx.defaultrowlen = 19;
    ctx.defaultcollen = 73;
    return ctx;
}

// Mirrors Workbook handleUndo: apply the filtered inverse patches.
function undo(ctx: Context, recipe: (draft: Context) => void): Context {
    const [next, , inversePatches] = produceWithPatches(ctx, recipe);
    return applyPatches(next, filterPatch(inversePatches));
}

function dragResize(ctx: Context) {
    const container = win.document.createElement('div') as unknown as HTMLDivElement;
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
    const event = { button: 0, pageX: 296, pageY: 150 } as unknown as MouseEvent;
    handleOverlayMouseUp(ctx, {} as GlobalCache, {} as Settings, event, scrollEl, container, null, null);
}

describe('a resize round-trips through undo', () => {
    test('column drag', () => {
        const base = resizeContext();
        const [resized] = produceWithPatches(base, (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            dragResize(ctx);
        });
        expect(resized.sheets[0].config?.columnlen?.[2]).toBe(153);

        const afterUndo = undo(base, (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            dragResize(ctx);
        });
        expect(afterUndo.sheets[0].config?.columnlen?.[2]).toBe(100);
    });

    test('row drag', () => {
        const base = resizeContext();
        const [resized] = produceWithPatches(base, (ctx: Context) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            dragResize(ctx);
        });
        expect(resized.sheets[0].config?.rowlen?.[2]).toBe(53);

        const afterUndo = undo(base, (ctx: Context) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            dragResize(ctx);
        });
        expect(afterUndo.sheets[0].config?.rowlen?.[2]).toBe(40);
    });

    test('setColumnWidth', () => {
        const afterUndo = undo(resizeContext(), (ctx: Context) => setColumnWidth(ctx, { 2: 153 }));
        expect(afterUndo.sheets[0].config?.columnlen?.[2]).toBe(100);
    });

    test('setRowHeight', () => {
        const afterUndo = undo(resizeContext(), (ctx: Context) => setRowHeight(ctx, { 2: 53 }));
        expect(afterUndo.sheets[0].config?.rowlen?.[2]).toBe(40);
    });
});

describe("a peer's resize reaches the sheet", () => {
    // Mirrors Workbook applyOp: opToPatch turns the remote op into a `sheets[*]` patch.
    test('a remote config op lands on the sheet', () => {
        const base = resizeContext();
        const op: Op = { op: 'replace', id: 'id_1', path: ['config'], value: { columnlen: { 2: 153 } } };
        const applied = produce(base, (ctx: Context) => {
            const [patches] = opToPatch(ctx, [op]);
            applyPatches(ctx, patches);
        });
        expect(applied.sheets[0].config?.columnlen?.[2]).toBe(153);
    });
});

// The granularity of the surviving patch is load-bearing and invisible to every value
// assertion above — both shapes round-trip on a single client. A whole-config replace is
// last-writer-wins: a peer's concurrent edit to an unrelated config key is silently
// clobbered, and undo reverts the whole config rather than the one key.
describe('a config write syncs as a granular patch, not a whole-config replace', () => {
    function configPatchPaths(recipe: (draft: Context) => void) {
        const [, patches] = produceWithPatches(resizeContext(), recipe);
        return filterPatch(patches).map((p) => p.path);
    }

    test('setRowHeight patches the rowlen key, not the config object', () => {
        const paths = configPatchPaths((ctx: Context) => setRowHeight(ctx, { 2: 53 }));
        expect(paths).toEqual([['sheets', 0, 'config', 'rowlen', '2']]);
    });

    test('setColumnWidth patches the columnlen key, not the config object', () => {
        const paths = configPatchPaths((ctx: Context) => setColumnWidth(ctx, { 2: 153 }));
        expect(paths).toEqual([['sheets', 0, 'config', 'columnlen', '2']]);
    });

    test('two writers to different config keys produce non-overlapping patches', () => {
        const paths = configPatchPaths((ctx: Context) => {
            setRowHeight(ctx, { 2: 53 });
            setColumnWidth(ctx, { 2: 153 });
        });
        expect(paths).toEqual([
            ['sheets', 0, 'config', 'rowlen', '2'],
            ['sheets', 0, 'config', 'columnlen', '2'],
        ]);
    });

    test('the inverse patch is granular too, so undo reverts one key', () => {
        const [, , inversePatches] = produceWithPatches(resizeContext(), (ctx: Context) =>
            setRowHeight(ctx, { 2: 53 }),
        );
        expect(filterPatch(inversePatches).map((p) => p.path)).toEqual([['sheets', 0, 'config', 'rowlen', '2']]);
    });
});
