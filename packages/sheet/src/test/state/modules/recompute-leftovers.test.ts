// A recompute holds nothing between edits, so nothing an earlier edit left behind reaches a later one.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Context } from '../../../state/context';
import { autoSelectionFormula } from '../../../state/modules/autosum';
import { updateCell } from '../../../state/modules/cell';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { replaceSearchMatch } from '../../../state/modules/search-replace';
import { sortRange } from '../../../state/modules/sort';
import { tab, tabEdit, tabUndo } from '../factories/collab';
import { contextFactory, selectionFactory } from '../factories/context';

function withDependent(a1: number | string, selections = selectionFactory([0, 0], [0, 0], 0, 0)): Context {
    const ctx = contextFactory({
        currentSheetId: 'id_1',
        selections,
        sheets: [
            {
                name: 'One',
                id: 'id_1',
                order: 0,
                data: [
                    [
                        { v: a1, m: `${a1}` },
                        { f: '=A1', v: a1, m: `${a1}` },
                        { v: 'x', m: 'x' },
                        { v: 'y', m: 'y' },
                    ],
                    [null, null, null, null],
                ],
            },
        ],
    }) as Context;
    warmFormulaCellInfoMap(ctx);
    return ctx;
}

describe('a recompute leaves nothing behind', () => {
    test('undoing a replace gives a dependent the old text back', () => {
        const t = tab(withDependent('foo'));
        warmFormulaCellInfoMap(t.ctx);
        tabEdit(t, (draft) => {
            replaceSearchMatch(
                draft,
                { sheetId: 'id_1', r: 0, c: 0 },
                'foo',
                'bar',
                { matchCase: false, wholeWord: false, regex: false },
                false,
            );
        });
        expect(t.ctx.sheets[0].data?.[0][1]?.v).toBe('bar');
        tabUndo(t);
        expect(t.ctx.sheets[0].data?.[0][0]?.v).toBe('foo');
        expect(t.ctx.sheets[0].data?.[0][1]?.v).toBe('foo');
    });

    test('an autosum that writes nothing does not swallow the next edit', () => {
        // Text across the selection: the autosum has nothing to sum and writes nothing.
        const ctx = produce(withDependent(1, selectionFactory([0, 0], [2, 3], 0, 2)), (draft: Context) => {
            autoSelectionFormula(draft, {} as HTMLDivElement, null, 'SUM');
            updateCell(draft, 0, 0, null, 5);
        });
        expect(ctx.sheets[0].data?.[0][1]?.v).toBe(5);
    });
});

describe('a writer recomputes after it writes', () => {
    test('a formula typed over a precedent reaches its dependent', () => {
        const ctx = withDependent(1);
        updateCell(ctx, 0, 0, null, '=1+1');
        expect(ctx.sheets[0].data?.[0][1]?.v).toBe(2);
    });

    test('a sort reaches a dependent outside its range', () => {
        const ctx = withDependent(2);
        const data = ctx.sheets[0].data;
        if (!data) throw new Error('no data');
        data[1][0] = { v: 1, m: '1' };
        const next = produce(ctx, (draft: Context) =>
            sortRange(draft, selectionFactory([0, 1], [0, 0], 0, 0)[0], true),
        );
        expect(next.sheets[0].data?.[0][0]?.v).toBe(1);
        expect(next.sheets[0].data?.[0][1]?.v).toBe(1);
    });

    test('a second edit in one recipe reads what the first recomputed', () => {
        const ctx = withDependent(1);
        updateCell(ctx, 0, 2, null, '=B1+1');
        updateCell(ctx, 0, 0, null, 5);
        updateCell(ctx, 0, 3, null, '=C1+1');
        expect(ctx.sheets[0].data?.[0][3]?.v).toBe(7);
    });
});
