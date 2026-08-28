// `ctx.config` is a derived mirror of `ctx.sheets[current].config` — every geometry
// read (calcRowColSize, the Sheet recompute effect) goes through the mirror, and the
// Workbook seeding effect re-points it only on a sheet switch. Resizing writes both,
// but filterPatch keeps only the `sheets[*]` half, so anything that applies patches
// from outside the seeding effect — undo, redo, a remote op — reverts the sheet and
// leaves the mirror holding the old size. These tests pin that both halves move
// together, on the drag path the bug was reported on, the api path, and the remote-op
// path. The drag handler needs a real DOM, so happy-dom is installed at module scope
// the way events/mouse-cell.test.ts does.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import { setColumnWidth, setRowHeight } from '../../../state/api/rowcol';
import { type Context, updateContextWithSheetConfig } from '../../../state/context';
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

// The seeding effect assigns `draftCtx.config = sheet.config`, so the mirror and the
// sheet's config start as the same object — reproduce that, not two clones.
function resizeContext(): Context {
    const config = { rowlen: { 2: 40 }, columnlen: { 2: 100 } };
    const ctx = contextFactory({ config }) as Context;
    ctx.sheets[0].config = config;
    ctx.rowHeaderWidth = 46;
    ctx.columnHeaderHeight = 20;
    ctx.defaultrowlen = 19;
    ctx.defaultcollen = 73;
    return ctx;
}

// Mirrors Workbook handleUndo: apply the filtered inverse patches, then re-point the
// mirror at the current sheet's config.
function undo(ctx: Context, recipe: (draft: Context) => void): Context {
    const [next, , inversePatches] = produceWithPatches(ctx, recipe);
    const reverted = applyPatches(next, filterPatch(inversePatches));
    return produce(reverted, (draft: Context) => {
        updateContextWithSheetConfig(draft);
    });
}

function dragResize(ctx: Context) {
    const container = win.document.createElement('div') as unknown as HTMLDivElement;
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
    const event = { button: 0, pageX: 296, pageY: 150 } as unknown as MouseEvent;
    handleOverlayMouseUp(ctx, {} as GlobalCache, {} as Settings, event, scrollEl, container, null, null);
}

describe('undo of a resize reverts the sheet AND the config mirror', () => {
    test('column drag', () => {
        const base = resizeContext();
        const [resized] = produceWithPatches(base, (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            dragResize(ctx);
        });
        expect(resized.config.columnlen?.[2]).toBe(153);
        expect(resized.sheets[0].config?.columnlen?.[2]).toBe(153);

        const afterUndo = undo(base, (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            dragResize(ctx);
        });
        expect(afterUndo.sheets[0].config?.columnlen?.[2]).toBe(100);
        expect(afterUndo.config.columnlen?.[2]).toBe(100);
    });

    test('row drag', () => {
        const base = resizeContext();
        const [resized] = produceWithPatches(base, (ctx: Context) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            dragResize(ctx);
        });
        expect(resized.config.rowlen?.[2]).toBe(53);
        expect(resized.sheets[0].config?.rowlen?.[2]).toBe(53);

        const afterUndo = undo(base, (ctx: Context) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            dragResize(ctx);
        });
        expect(afterUndo.sheets[0].config?.rowlen?.[2]).toBe(40);
        expect(afterUndo.config.rowlen?.[2]).toBe(40);
    });

    test('setColumnWidth', () => {
        const afterUndo = undo(resizeContext(), (ctx: Context) => setColumnWidth(ctx, { 2: 153 }));
        expect(afterUndo.sheets[0].config?.columnlen?.[2]).toBe(100);
        expect(afterUndo.config.columnlen?.[2]).toBe(100);
    });

    test('setRowHeight', () => {
        const afterUndo = undo(resizeContext(), (ctx: Context) => setRowHeight(ctx, { 2: 53 }));
        expect(afterUndo.sheets[0].config?.rowlen?.[2]).toBe(40);
        expect(afterUndo.config.rowlen?.[2]).toBe(40);
    });
});

describe("a peer's resize reaches the config mirror", () => {
    // Mirrors Workbook applyOp: opToPatch turns the remote op into a `sheets[*]` patch,
    // which leaves the mirror untouched on its own.
    test('a remote config op moves both halves', () => {
        const base = resizeContext();
        const op: Op = { op: 'replace', id: 'id_1', path: ['config'], value: { columnlen: { 2: 153 } } };
        const applied = produce(base, (ctx: Context) => {
            const [patches] = opToPatch(ctx, [op]);
            applyPatches(ctx, patches);
            updateContextWithSheetConfig(ctx);
        });
        expect(applied.sheets[0].config?.columnlen?.[2]).toBe(153);
        expect(applied.config.columnlen?.[2]).toBe(153);
    });
});
