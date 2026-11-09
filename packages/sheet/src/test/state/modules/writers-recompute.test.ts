// A merge, a saved link and a split write cells, so each keeps the formula map and the formulas that read those cells
// up to date, and its undo brings both back.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { saveHyperlink } from '../../../state/modules/hyperlink';
import { mergeCells } from '../../../state/modules/merge';
import { getDataArr, getRegStr, updateMoreCell } from '../../../state/modules/split-column';
import type { Cell } from '../../../state/types';
import { join, tab, tabEdit, tabUndo } from '../factories/collab';
import { contextFactory, selectionFactory } from '../factories/context';

function rowTab(row: (Cell | null)[]) {
    const t = tab(
        contextFactory({
            currentSheetId: 'id_1',
            sheets: [{ name: 'One', id: 'id_1', order: 0, data: [row] }],
        }) as Context,
    );
    warmFormulaCellInfoMap(t.ctx);
    return t;
}

const formulasAt = (ctx: Context) => Object.keys(ctx.formulaCache.formulaCellInfoMap ?? {}).sort();
const valuesOf = (ctx: Context) => ctx.sheets[0].data?.[0].map((cell) => cell?.v);
const formulaAt = (ctx: Context, c: number) => ctx.sheets[0].data?.[0][c]?.f;

describe('a merge recomputes what it covered', () => {
    const covering = () =>
        rowTab([
            { v: 5, m: '5' },
            { f: '=A1+1', v: 6, m: '6' },
            { f: '=B1*10', v: 60, m: '60' },
            { f: '=A1', v: 5, m: '5' },
        ]);
    const A1_B1 = [{ row: [0, 0], column: [0, 1] }];

    test('a covered formula leaves the map and its reader recomputes', () => {
        const t = covering();
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-all'));
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1', 'r0c3iid_1']);
        expect(valuesOf(t.ctx)).toEqual([5, undefined, 0, 5]);
    });

    test('undo brings the covered formula and its reader back', () => {
        const t = covering();
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-all'));
        tabUndo(t);
        expect(formulaAt(t.ctx, 1)).toBe('=A1+1');
        expect(formulasAt(t.ctx)).toEqual(['r0c1iid_1', 'r0c2iid_1', 'r0c3iid_1']);
        expect(valuesOf(t.ctx)).toEqual([5, 6, 60, 5]);
    });

    test('a formula kept as the merged value moves in the map, and reads what the merge cleared', () => {
        const t = rowTab([
            null,
            { f: '=C1+1', v: 6, m: '6' },
            { v: 5, m: '5' },
            { f: '=C1', v: 5, m: '5' },
            { f: '=B1', v: 6, m: '6' },
            { f: '=A1', v: 0, m: '0' },
        ]);
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', [{ row: [0, 0], column: [0, 2] }], 'merge-all'));
        expect(formulaAt(t.ctx, 0)).toBe('=C1+1');
        expect(formulasAt(t.ctx)).toEqual(['r0c0iid_1', 'r0c3iid_1', 'r0c4iid_1', 'r0c5iid_1']);
        expect(valuesOf(t.ctx)).toEqual([1, undefined, undefined, 0, 0, 1]);
        tabUndo(t);
        expect(formulasAt(t.ctx)).toEqual(['r0c1iid_1', 'r0c3iid_1', 'r0c4iid_1', 'r0c5iid_1']);
        expect(valuesOf(t.ctx)).toEqual([undefined, 6, 5, 5, 6, 0]);
    });

    test('a kept formula that reads its own new cell computes without hanging', () => {
        const t = rowTab([null, { f: '=A1', v: 0, m: '0' }, { f: '=A1+1', v: 1, m: '1' }]);
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-all'));
        expect(formulaAt(t.ctx, 0)).toBe('=A1');
        expect(formulasAt(t.ctx)).toEqual(['r0c0iid_1', 'r0c2iid_1']);
    });

    test('merging row by row covers and recomputes as well', () => {
        const t = covering();
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-horizontal'));
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1', 'r0c3iid_1']);
        expect(valuesOf(t.ctx)).toEqual([5, undefined, 0, 5]);
    });

    test('every range of the selection recomputes', () => {
        const t = covering();
        tabEdit(t, (ctx) =>
            mergeCells(
                ctx,
                'id_1',
                [
                    { row: [0, 0], column: [0, 1] },
                    { row: [0, 0], column: [2, 3] },
                ],
                'merge-all',
            ),
        );
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1']);
        expect(valuesOf(t.ctx)).toEqual([5, undefined, 0, undefined]);
    });

    test('an unmerge leaves the values as they are', () => {
        const t = covering();
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-all'));
        tabEdit(t, (ctx) => mergeCells(ctx, 'id_1', A1_B1, 'merge-cancel'));
        expect(t.ctx.sheets[0].data?.[0][0]?.mc).toBeUndefined();
        expect(t.ctx.sheets[0].config?.merge).toEqual({});
        expect(valuesOf(t.ctx)).toEqual([5, undefined, 0, 5]);
    });
});

describe('a link saved over a formula', () => {
    const linked = () =>
        rowTab([
            { f: '=B1*2', v: 4, m: '4' },
            { v: 2, m: '2' },
            { f: '=A1', v: 4, m: '4' },
        ]);
    const save = (text: string) => (ctx: Context) => saveHyperlink(ctx, 0, 0, text, 'webpage', 'https://eigen.is');

    test('new text replaces the formula, for a joiner too, and its reader recomputes', () => {
        const t = linked();
        const base = t.ctx;
        const ops = tabEdit(t, save('Docs'));
        expect(formulaAt(t.ctx, 0)).toBeUndefined();
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1']);
        expect(valuesOf(t.ctx)).toEqual(['Docs', 2, 'Docs']);
        const joined = join(base, [ops])[0].data?.[0];
        expect(joined?.[0]?.f).toBeUndefined();
        expect(joined?.[2]?.v).toBe('Docs');
        tabEdit(t, (ctx) => updateCell(ctx, 0, 1, null, 3));
        expect(valuesOf(t.ctx)).toEqual(['Docs', 3, 'Docs']);
    });

    test('undo brings the formula and its reader back', () => {
        const t = linked();
        tabEdit(t, save('Docs'));
        tabUndo(t);
        expect(formulaAt(t.ctx, 0)).toBe('=B1*2');
        expect(formulasAt(t.ctx)).toEqual(['r0c0iid_1', 'r0c2iid_1']);
        expect(valuesOf(t.ctx)).toEqual([4, 2, 4]);
        expect(t.ctx.sheets[0].hyperlink?.['0_0']).toBeUndefined();
    });

    test('the text the card showed keeps the formula', () => {
        const t = linked();
        tabEdit(t, save('4'));
        expect(formulaAt(t.ctx, 0)).toBe('=B1*2');
        expect(formulasAt(t.ctx)).toEqual(['r0c0iid_1', 'r0c2iid_1']);
        expect(t.ctx.sheets[0].hyperlink?.['0_0']?.linkAddress).toBe('https://eigen.is');
        tabEdit(t, (ctx) => updateCell(ctx, 0, 1, null, 3));
        expect(valuesOf(t.ctx)).toEqual([6, 3, 6]);
    });

    test('new text over a plain value reaches its reader', () => {
        const t = rowTab([
            { v: 1, m: '1' },
            { f: '=A1', v: 1, m: '1' },
        ]);
        tabEdit(t, save('Docs'));
        expect(valuesOf(t.ctx)).toEqual(['Docs', 'Docs']);
        tabUndo(t);
        expect(valuesOf(t.ctx)).toEqual([1, 1]);
    });

    test('a link on an empty cell writes its address and reaches its reader', () => {
        const t = rowTab([null, { f: '=A1', v: 0, m: '0' }]);
        tabEdit(t, save(''));
        expect(valuesOf(t.ctx)).toEqual(['https://eigen.is', 'https://eigen.is']);
    });
});

describe('a split over a formula', () => {
    const splitting = () =>
        rowTab([
            { f: '=E1', v: 'a,b', m: 'a,b' },
            { f: '=E1', v: 'a,b', m: 'a,b' },
            { f: '=A1', v: 'a,b', m: 'a,b' },
            { f: '=B1', v: 'a,b', m: 'a,b' },
            { v: 'a,b', m: 'a,b' },
        ]);
    const split = (pieces: string[]) => (ctx: Context) => updateMoreCell(0, 0, [pieces], ctx);

    test('the pieces replace the formulas, and their readers recompute', () => {
        const t = splitting();
        tabEdit(t, split(['a', 'b']));
        expect(formulaAt(t.ctx, 0)).toBeUndefined();
        expect(formulaAt(t.ctx, 1)).toBeUndefined();
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1', 'r0c3iid_1']);
        expect(valuesOf(t.ctx)).toEqual(['a', 'b', 'a', 'b', 'a,b']);
    });

    test('undo brings the formulas and their readers back', () => {
        const t = splitting();
        tabEdit(t, split(['a', 'b']));
        tabUndo(t);
        expect(formulaAt(t.ctx, 0)).toBe('=E1');
        expect(formulaAt(t.ctx, 1)).toBe('=E1');
        expect(formulasAt(t.ctx)).toEqual(['r0c0iid_1', 'r0c1iid_1', 'r0c2iid_1', 'r0c3iid_1']);
        expect(valuesOf(t.ctx)).toEqual(['a,b', 'a,b', 'a,b', 'a,b', 'a,b']);
    });

    test('an empty piece clears a formula as well', () => {
        const t = splitting();
        tabEdit(t, split(['a', '']));
        expect(formulaAt(t.ctx, 1)).toBeUndefined();
        expect(formulasAt(t.ctx)).toEqual(['r0c2iid_1', 'r0c3iid_1']);
        expect(t.ctx.sheets[0].data?.[0][1]?.v).toBeUndefined();
    });

    test('a piece over a plain value reaches its reader', () => {
        const t = rowTab([{ v: 'a,b', m: 'a,b' }, null, { f: '=B1', v: 0, m: '0' }]);
        tabEdit(t, split(['a', 'b']));
        expect(valuesOf(t.ctx)).toEqual(['a', 'b', 'b']);
    });
});

describe('the split dialog reads its pieces', () => {
    const column = (...values: string[]) =>
        contextFactory({
            currentSheetId: 'id_1',
            selections: selectionFactory([0, values.length - 1], [0, 0], 0, 0),
            sheets: [{ name: 'One', id: 'id_1', order: 0, data: values.map((v) => [{ v, m: v }]) }],
        }) as Context;

    test('the pattern joins the chosen separators', () => {
        expect(getRegStr(new Set(['Tab', 'semicolon', 'comma', 'space']), '')).toBe('\\t|;|,|\\s');
        expect(getRegStr(new Set(['comma', 'other']), '-')).toBe(',|-');
        expect(getRegStr(new Set(['other']), '')).toBe('');
        expect('a,,b'.split(new RegExp(getRegStr(new Set(['comma', 'splitsimple']), ''), 'g'))).toEqual(['a', 'b']);
    });

    test('short rows pad to the widest, and no separator keeps each cell whole', () => {
        const ctx = column('a,b,c', 'd');
        expect(getDataArr(',', ctx)).toEqual([
            ['a', 'b', 'c'],
            ['d', '', ''],
        ]);
        expect(getDataArr('', ctx)).toEqual([['a,b,c'], ['d']]);
    });
});
