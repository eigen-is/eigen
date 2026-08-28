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
import { produce } from 'immer';
import { initSheetData } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { mergeCells } from '../../../state/modules/merge';
import { emitOps, receiveOps, syncablePaths } from '../factories/collab';
import { contextFactory } from '../factories/context';
import { mouseUpAt, withGridGeometry } from '../factories/grid-dom';

function sharedDocument(): Context {
    return withGridGeometry(
        contextFactory({
            config: { rowlen: { 2: 40 }, columnlen: { 2: 100 }, merge: {}, customHeight: {} },
        }) as Context,
    );
}

// A sheet as it actually arrives from initSheetData, which materializes every config
// collection. Pre-seeding them in a fixture is what hid the first-write clobber below.
function freshDocument(): Context {
    const ctx = withGridGeometry(contextFactory() as Context);
    ctx.sheets[0].config = undefined;
    initSheetData(ctx, 0, ctx.sheets[0]);
    return ctx;
}

function mergeTwoCells(ctx: Context) {
    mergeCells(ctx, ctx.currentSheetId, [{ row: [1, 1], column: [1, 2] }], 'merge-all');
}

function dragRowTaller(ctx: Context) {
    ctx.rowsResizing = true;
    ctx.rowsResizeStart = [100, 2];
    mouseUpAt(296, 150)(ctx);
}

describe('two clients editing different keys of one config', () => {
    test('a merge survives a peer resizing a row', () => {
        const base = sharedDocument();
        const final = receiveOps(receiveOps(base, emitOps(base, mergeTwoCells)), emitOps(base, dragRowTaller));

        expect(final.sheets[0].config?.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 1, cs: 2 } });
        expect(final.sheets[0].config?.rowlen?.[2]).toBe(53);
    });

    test('a row resize survives a peer merging cells', () => {
        const base = sharedDocument();
        const final = receiveOps(receiveOps(base, emitOps(base, dragRowTaller)), emitOps(base, mergeTwoCells));

        expect(final.sheets[0].config?.merge).toEqual({ '1_1': { r: 1, c: 1, rs: 1, cs: 2 } });
        expect(final.sheets[0].config?.rowlen?.[2]).toBe(53);
    });
});

describe('every config writer emits a granular op, never a whole-config replace', () => {
    const configPaths = (recipe: (ctx: Context) => void) =>
        syncablePaths(sharedDocument(), recipe)
            .map((path) => path.slice(2))
            .filter((path) => path[0] === 'config');

    test('merging cells patches the merge key', () => {
        expect(configPaths(mergeTwoCells)).toEqual([['config', 'merge', '1_1']]);
    });

    test('dragging a row taller patches the rowlen key', () => {
        expect(configPaths(dragRowTaller)).toEqual([
            ['config', 'rowlen', '2'],
            ['config', 'customHeight', '2'],
        ]);
    });
});

// The first write to a config collection is the case a pre-seeded fixture cannot see: immer
// records key creation as one `add` carrying the whole collection, so before initSheetData
// materialized them, two clients each making their FIRST resize on a fresh sheet each sent
// the entire rowlen map and silently overwrote the other.
describe('two clients writing a config key for the first time', () => {
    const dragRow = (rowIndex: number) => (ctx: Context) => {
        ctx.rowsResizing = true;
        ctx.rowsResizeStart = [100, rowIndex];
        mouseUpAt(296, 150)(ctx);
    };

    test('each client patches one key, not the whole rowlen map', () => {
        const base = freshDocument();
        for (const ops of [emitOps(base, dragRow(2)), emitOps(base, dragRow(3))]) {
            expect(ops.map((op) => op.path)).toEqual([
                ['config', 'rowlen', expect.any(String)],
                ['config', 'customHeight', expect.any(String)],
            ]);
        }
    });

    test('two first-time resizes of different rows both survive', () => {
        const base = freshDocument();
        const a = dragRow(2);
        const b = dragRow(3);

        const onA = receiveOps(produce(base, a), emitOps(base, b));
        const onB = receiveOps(produce(base, b), emitOps(base, a));

        expect(onA.sheets[0].config?.rowlen).toEqual(onB.sheets[0].config?.rowlen ?? {});
        expect(Object.keys(onA.sheets[0].config?.rowlen ?? {}).sort()).toEqual(['2', '3']);
    });
});
