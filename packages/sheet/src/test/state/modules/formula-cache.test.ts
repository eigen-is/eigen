// updateFormulaCache after undo/redo: a paste replaces whole cells, so the history carries
// whole-cell patches, and the map has to follow them either way.

import { describe, expect, it } from 'bun:test';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { handlePasteByClick } from '../../../state/events/paste';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { copy } from '../../../state/modules/selection';
import { contextFactory } from '../factories/context';
import { edit, redo, sel, typed, undo } from '../factories/edit-cycle';

// copy() writes the plain-text clipboard through document and sessionStorage.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = { createElement: () => ({ innerHTML: '', innerText: '', textContent: '' }) };
g.sessionStorage = { setItem: () => {} };

// A1 = 5, B1 = =A1*2, C1 = 3
function makeCtx(): Context {
    const data: (Cell | null)[][] = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = { f: '=A1*2', v: 10, m: '10' };
    data[0][2] = { v: 3, m: '3' };
    return contextFactory({
        currentSheetId: 'id_1',
        selections: sel(0, 0, 0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data, calcChain: [{ r: 0, c: 1, id: 'id_1' }] }],
    }) as Context;
}

const pasteInternal = (from: [number, number], to: [number, number]) => (d: Context) => {
    d.selections = sel(from[0], from[0], from[1], from[1]);
    copy(d);
    d.pasteIsCut = false;
    d.selections = sel(to[0], to[0], to[1], to[1]);
    handlePasteByClick(d, 'internal');
};

const cell = (ctx: Context, r: number, c: number) => ctx.sheets[0].data![r][c];

describe('updateFormulaCache — whole-cell patches', () => {
    it('undoing a formula pasted over a value drops it from the map', () => {
        const base = makeCtx();
        warmFormulaCellInfoMap(base);
        const [pasted, history] = edit(base, pasteInternal([0, 1], [0, 2]));
        expect(cell(pasted, 0, 2)?.f).toBe('=B1*2');

        let ctx = undo(pasted, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.v).toBe(18);
        expect(cell(ctx, 0, 2)?.f).toBeUndefined();
        expect(cell(ctx, 0, 2)?.v).toBe(3);
    });

    it('redoing a value pasted over a formula drops it from the map', () => {
        const [pasted, history] = edit(makeCtx(), pasteInternal([0, 2], [0, 1]));
        let ctx = undo(pasted, history);
        expect(cell(ctx, 0, 1)?.f).toBe('=A1*2');

        ctx = redo(ctx, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.f).toBeUndefined();
        expect(cell(ctx, 0, 1)?.v).toBe(3);
    });

    it('undoing a value pasted over a formula puts it back in the map', () => {
        const [pasted, history] = edit(makeCtx(), pasteInternal([0, 2], [0, 1]));
        let ctx = undo(pasted, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.v).toBe(18);
    });
});
