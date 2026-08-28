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
