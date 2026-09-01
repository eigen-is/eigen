// A resize writes the current sheet's config, and filterPatch keeps only the `sheets[*]`
// half of a recipe's patches, so the write has to land there or it neither syncs nor
// undoes. These pin the round trip on the drag path the bug was reported on, the api
// path, and the remote-op path, plus the granularity of the patch each one emits — a
// whole-config replace round-trips just as well on one client, so only the patch path
// tells the two apart. The drag handler needs a real DOM, so happy-dom is installed at
// module scope the way events/mouse-cell.test.ts does.

import { describe, expect, test } from 'bun:test';
import { applyPatches, produce, produceWithPatches } from 'immer';
import { setColumnWidth, setRowHeight } from '../../../state/api/rowcol';
import type { Context } from '../../../state/context';
import type { Op } from '../../../state/types';
import { filterPatch, opToPatch } from '../../../state/utils/patch';
import { syncablePaths } from '../factories/collab';
import { contextFactory } from '../factories/context';
import { mouseUpAt, withGridGeometry } from '../factories/grid-dom';

const resizeContext = () =>
    withGridGeometry(contextFactory({ config: { rowlen: { 2: 40 }, columnlen: { 2: 100 } } }) as Context);

// Mirrors Workbook handleUndo: apply the filtered inverse patches.
function undo(ctx: Context, recipe: (draft: Context) => void): Context {
    const [next, , inversePatches] = produceWithPatches(ctx, recipe);
    return applyPatches(next, filterPatch(inversePatches));
}

// Start positions are page coordinates now, so movement is just the difference:
// rows start at 100 and move +33 (rowlen 40 -> 73), columns start at 200 and move +53 (100 -> 153).
const dragResize = mouseUpAt(253, 133);

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
        expect(resized.sheets[0].config?.rowlen?.[2]).toBe(73);

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
    const configPatchPaths = (recipe: (draft: Context) => void) => syncablePaths(resizeContext(), recipe);

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

test('a drag survives a sibling suite deleting globalThis.window', () => {
    // Pins the CI order flake: hyperlink.test.ts's cleanup used to delete the global
    // window after grid-dom's cached module had already installed it.
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis surgery
    delete (globalThis as any).window;
    const ctx = resizeContext();
    ctx.colsResizing = true;
    ctx.colsResizeStart = [200, 2];
    expect(() => produce(ctx, (draft: Context) => void dragResize(draft))).not.toThrow();
});
