// Two clients branch from the same document state, each edits a DIFFERENT key of the same
// sheet config, and the ops are replayed in order. Both edits must survive.
//
// They did not, before `ctx.config` was deleted. The row-height drag assigned the config
// mirror into the sheet slot, and immer records assigning a FOREIGN draft into a slot as one
// `replace ['sheets',i,'config']` carrying the whole config object. Replayed on a peer that
// overwrote every key, so whichever client's op landed second destroyed the other's work.
//
// These assert the CONTRACT (both edits survive the round trip), and separately pin the op
// PATH, because the value assertions alone cannot see the difference on a single client — a
// whole-config op round-trips perfectly until a second client is involved.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { handleOverlayMouseUp } from '../../../state/events/mouse-drag';
import { mergeCells } from '../../../state/modules/merge';
import type { Settings } from '../../../state/settings';
import type { GlobalCache, Op } from '../../../state/types';
import { filterPatch, opToPatch, patchToOp } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

function sharedDocument(): Context {
    const ctx = contextFactory({
        config: { rowlen: { 2: 40 }, columnlen: { 2: 100 }, merge: {}, customHeight: {} },
    }) as Context;
    ctx.rowHeaderWidth = 46;
    ctx.columnHeaderHeight = 20;
    ctx.defaultrowlen = 19;
    ctx.defaultcollen = 73;
    return ctx;
}

// One client's local edit: produce, keep the syncable patches, turn them into the ops that go
// on the wire. Mirrors Workbook setContextWithProduce + emitOp.
function edit(base: Context, recipe: (ctx: Context) => void): Op[] {
    const [next, patches] = produceWithPatches(base, recipe);
    return patchToOp(next, filterPatch(patches));
}

// A peer receiving those ops. Mirrors the Workbook applyOp path.
function receive(ctx: Context, ops: Op[]): Context {
    return produce(ctx, (draft: Context) => {
        const [patches] = opToPatch(draft, ops);
        applyPatches(draft, patches);
    });
}

function mergeF41(ctx: Context) {
    mergeCells(ctx, ctx.currentSheetId, [{ row: [1, 1], column: [1, 2] }], 'merge-all');
}

function dragRowTaller(ctx: Context) {
    const container = win.document.createElement('div') as unknown as HTMLDivElement;
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
    const event = { button: 0, pageX: 296, pageY: 150 } as unknown as MouseEvent;
    ctx.rowsResizing = true;
    ctx.rowsResizeStart = [100, 2];
    handleOverlayMouseUp(ctx, {} as GlobalCache, {} as Settings, event, scrollEl, container, null, null);
}

describe('two clients editing different keys of one config', () => {
    test('a merge survives a peer resizing a row', () => {
        const base = sharedDocument();
        const merge = edit(base, mergeF41);
        const resize = edit(base, dragRowTaller);

        const final = receive(receive(base, merge), resize);

        expect(final.sheets[0].config?.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 1, cs: 2 } });
        expect(final.sheets[0].config?.rowlen?.[2]).toBe(53);
    });

    test('a row resize survives a peer merging cells', () => {
        const base = sharedDocument();
        const merge = edit(base, mergeF41);
        const resize = edit(base, dragRowTaller);

        const final = receive(receive(base, resize), merge);

        expect(final.sheets[0].config?.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 1, cs: 2 } });
        expect(final.sheets[0].config?.rowlen?.[2]).toBe(53);
    });
});

describe('every config writer emits a granular op, never a whole-config replace', () => {
    function opPaths(recipe: (ctx: Context) => void) {
        return edit(sharedDocument(), recipe)
            .map((op) => op.path)
            .filter((path) => path[0] === 'config');
    }

    test('merging cells patches the merge key', () => {
        expect(opPaths(mergeF41)).toEqual([['config', 'merge', '1_1']]);
    });

    test('dragging a row taller patches the rowlen key', () => {
        expect(opPaths(dragRowTaller)).toEqual([
            ['config', 'rowlen', '2'],
            ['config', 'customHeight', '2'],
        ]);
    });
});
