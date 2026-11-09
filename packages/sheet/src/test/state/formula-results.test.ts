// What a sort, a paste and a formula's result leave in a cell, on two tabs and a joiner through the real record, applyOp
// and undo steps. A sort writes only what it lands, so a stale number in a row that stays is kept. A pasted formula
// computes where it lands, with the type of its own answer. An empty-text result is one stored shape on every path.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../state/context';
import { updateCell } from '../../state/modules/cell';
import { copy } from '../../state/modules/clipboard';
import { sortRange } from '../../state/modules/sort';
import type { Cell, Op, Sheet } from '../../state/types';
import { pasteCopy, pasteText } from './factories/clipboard';
import { join, tab, tabEdit, tabReceive, tabUndo } from './factories/collab';
import { workbookContextFactory } from './factories/context';

const number = (v: number, fa = 'General'): Cell => ({ v, m: `${v}`, ct: { fa, t: 'n' } });
const held = (f: string, v: number, fa = 'General'): Cell => ({ ...number(v, fa), f });

const rowOf = (name: string) => Number(name.slice(1)) - 1;
const columnOf = (name: string) => name.charCodeAt(0) - 65;

function session(cells: Record<string, Cell>) {
    const data: (Cell | null)[][] = Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => null));
    for (const [name, cell] of Object.entries(cells)) data[rowOf(name)][columnOf(name)] = cell;
    const base = workbookContextFactory({
        currentSheetId: 's1',
        sheets: [{ id: 's1', name: 'One', order: 0, data, config: {} }],
    });
    const a = tab(base);
    const b = tab(base);
    const batches: Op[][] = [];
    const send = (ops: Op[]) => {
        if (ops.length > 0) batches.push(ops);
        tabReceive(b, ops);
        return ops;
    };
    return {
        edit: (recipe: (ctx: Context) => void) => send(tabEdit(a, recipe)),
        undo: () => send(tabUndo(a)),
        readers: () => [a.ctx.sheets[0], b.ctx.sheets[0], join(base, batches)[0]],
    };
}

const at = ({ data }: Sheet, name: string) => data?.[rowOf(name)]?.[columnOf(name)];

function expectEveryone(s: ReturnType<typeof session>, name: string, expected: Partial<Cell>) {
    for (const sheet of s.readers()) expect(at(sheet, name) ?? {}).toMatchObject(expected);
}

const typed = (name: string, value: string) => (draft: Context) => {
    draft.selections = [{ row: [rowOf(name), rowOf(name)], column: [columnOf(name), columnOf(name)] }];
    updateCell(draft, rowOf(name), columnOf(name), null, value);
};

const pasted = (from: string, to: string) => (draft: Context) => {
    draft.selections = [{ row: [rowOf(from), rowOf(from)], column: [columnOf(from), columnOf(from)] }];
    copy(draft, { cut: false });
    draft.selections = [{ row: [rowOf(to), rowOf(to)], column: [columnOf(to), columnOf(to)] }];
    pasteCopy(draft);
};

describe('a sort writes only what it lands', () => {
    // 3, 2, 1 ascending swaps rows 1 and 3, and row 2 sorts onto itself.
    const COLUMN = { A1: number(3), A2: number(2), A3: number(1), H1: number(5) };
    const sortA1B3 = (draft: Context) => sortRange(draft, { row: [0, 2], column: [0, 1] }, true);

    test('a formula in a row that stays keeps a stale number, through the sort and its undo', () => {
        const s = session({ ...COLUMN, B2: held('=$H$1*2', 999) });
        s.edit(sortA1B3);
        expectEveryone(s, 'B2', { f: '=$H$1*2', v: 999, m: '999' });
        s.undo();
        expectEveryone(s, 'B2', { f: '=$H$1*2', v: 999, m: '999' });
    });

    test('a formula in a hidden row keeps its number', () => {
        const s = session({ ...COLUMN, A2: number(0), B2: held('=$H$1*2', 999) });
        s.edit((draft) => {
            draft.sheets[0].config = { rowhidden: { 1: 0 } };
        });
        s.edit(sortA1B3);
        expectEveryone(s, 'B2', { v: 999 });
    });

    test('a random number in a row that stays does not roll again', () => {
        const s = session({ ...COLUMN, B2: held('=RAND()', 0.5) });
        s.edit(sortA1B3);
        expectEveryone(s, 'B2', { v: 0.5 });
    });

    test('a formula outside the range that reads a row that stays keeps its number', () => {
        const s = session({ ...COLUMN, D1: held('=A2*2', 999) });
        s.edit(sortA1B3);
        expectEveryone(s, 'D1', { v: 999 });
    });

    test('a formula outside the range that reads a landed cell computes, and an undo computes it back', () => {
        const s = session({ ...COLUMN, D1: held('=A1*2', 6) });
        s.edit(sortA1B3);
        expectEveryone(s, 'D1', { v: 2 });
        s.undo();
        expectEveryone(s, 'D1', { v: 6 });
    });

    test('a formula that moves is computed where it lands, and every reader holds its answer', () => {
        const s = session({ ...COLUMN, B1: held('=$H$1*2', 999) });
        s.edit(sortA1B3);
        expectEveryone(s, 'B3', { f: '=$H$1*2', v: 10 });
    });
});

describe('an empty-text result', () => {
    const IF_ONE = '=IF(A1=1,"",5)';
    const IMPORTED: Cell = { f: IF_ONE, v: '', m: '', ct: { fa: 'General', t: 'g' } };

    test('is one stored shape, from the editor as from an import, and shows blank', () => {
        const s = session({ A1: number(1), C1: IMPORTED });
        s.edit(typed('B1', IF_ONE));
        for (const sheet of s.readers()) expect(at(sheet, 'B1')).toEqual(IMPORTED);
    });

    test('plus one is #VALUE!, on either cell, as in Excel', () => {
        const s = session({ A1: number(1), C1: IMPORTED });
        s.edit(typed('B1', IF_ONE));
        s.edit(typed('B2', '=B1+1'));
        s.edit(typed('C2', '=C1+1'));
        expectEveryone(s, 'B2', { v: '#VALUE!' });
        expectEveryone(s, 'C2', { v: '#VALUE!' });
    });

    test('a reader gives one answer, in the pass of the flip and in a later one', () => {
        const s = session({ A1: number(0), B1: held(IF_ONE, 5), C1: held('=B1+1', 6), H1: number(1) });
        s.edit(typed('A1', '1'));
        expectEveryone(s, 'B1', { v: '', m: '' });
        expectEveryone(s, 'C1', { v: '#VALUE!' });
        s.edit(typed('C2', '=B1+1'));
        expectEveryone(s, 'C2', { v: '#VALUE!' });
    });

    test('takes away the type an error left', () => {
        const s = session({
            A1: number(0),
            B1: { f: '=IF(A1=1,"",1/0)', v: '#DIV/0!', m: '#DIV/0!', ct: { fa: 'General', t: 'e' } },
        });
        s.edit(typed('A1', '1'));
        expectEveryone(s, 'B1', { v: '', m: '', ct: { fa: 'General', t: 'g' } });
    });

    test('a cleared formula cell holds no value and no formula', () => {
        const s = session({ A1: number(1), B1: IMPORTED });
        s.edit((draft) => {
            draft.selections = [{ row: [0, 0], column: [1, 1] }];
            updateCell(draft, 0, 1, null, '');
        });
        for (const sheet of s.readers()) {
            expect(at(sheet, 'B1')?.f).toBeUndefined();
            expect(at(sheet, 'B1')?.v ?? null).toBeNull();
        }
    });
});
