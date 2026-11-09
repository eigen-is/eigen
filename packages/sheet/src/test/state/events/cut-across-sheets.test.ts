// A formula cut to another sheet follows Excel: it keeps reading the cells it read, and a ref to a cell that moved with
// it follows that cell. The author, a peer, a joiner, an undo and a redo all land the same text and value.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { dataToCelldata } = await import('../../../engine/celldata');
const { defaultContext } = await import('../../../state/context');
const { updateCell } = await import('../../../state/modules/cell');
const { copy } = await import('../../../state/modules/clipboard');
const { pasteCopy } = await import('../factories/clipboard');
const { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } = await import('../factories/collab');
type Context = import('../../../state/context').Context;
type Cell = import('../../../engine/types').Cell;
type Sheet = import('../../../state/types').Sheet;

const single = (r: number, c: number) => [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }];
const grid = (): (Cell | null)[][] => Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));

// One!A1 = 5, One!B1 = =A1*2, One!C1 = =B1+1 and Two!A1 = 100.
function base(sourceName = 'One'): Context {
    const one = grid();
    one[0][0] = { v: 5, m: '5' };
    one[0][1] = { f: '=A1*2', v: 10, m: '10', ct: { fa: 'General', t: 'n' } };
    one[0][2] = { f: '=B1+1', v: 11, m: '11', ct: { fa: 'General', t: 'n' } };
    const two = grid();
    two[0][0] = { v: 100, m: '100' };
    const ref = <T>(): { current: T | null } => ({ current: null });
    return {
        ...defaultContext({
            globalCache: { undoList: [], redoList: [], scrollLeft: 0, scrollTop: 0, scrollListeners: new Set() },
            cellInput: ref(),
            fxInput: ref(),
            canvas: ref(),
            cellArea: ref(),
            workbookContainer: ref(),
            hooks: { current: {} },
        }),
        currentSheetId: 'id_1',
        selections: single(0, 0),
        allowEdit: true,
        sheets: [
            { name: sourceName, id: 'id_1', order: 0, data: one, config: {} },
            { name: 'Two', id: 'id_2', order: 1, data: two, config: {} },
        ],
    };
}

// Cuts One!B1:C1 and pastes it at Two!D1.
function cutBlock(ctx: Context) {
    ctx.currentSheetId = 'id_1';
    ctx.selections = [{ row: [0, 0], column: [1, 2], row_focus: 0, column_focus: 1 }];
    copy(ctx, { cut: true });
    ctx.currentSheetId = 'id_2';
    ctx.selections = single(0, 3);
    pasteCopy(ctx);
}

const typeOnFirstSheet = (value: string) => (ctx: Context) => {
    ctx.currentSheetId = 'id_1';
    ctx.selections = single(0, 0);
    updateCell(ctx, 0, 0, null, value);
};

// The formula cells of every sheet, keyed by place, as text and value, however the sheet holds its cells.
function formulas(sheets: Pick<Sheet, 'data' | 'celldata' | 'name'>[]) {
    const out: Record<string, unknown> = {};
    for (const sheet of sheets) {
        for (const { r, c, v } of sheet.data ? dataToCelldata(sheet.data) : (sheet.celldata ?? [])) {
            if (v?.f) out[`${sheet.name}!${r}_${c}`] = [v.f, v.v];
        }
    }
    return out;
}

const moved = {
    'Two!0_3': ['=One!A1*2', 10],
    'Two!0_4': ['=D1+1', 11],
};
const before = {
    'One!0_1': ['=A1*2', 10],
    'One!0_2': ['=B1+1', 11],
};

describe('a block cut to another sheet', () => {
    test('a ref outside the block names the old sheet, one inside follows the block unqualified', () => {
        const author = tab(base());
        tabEdit(author, cutBlock);
        expect(formulas(author.ctx.sheets)).toEqual(moved);
    });

    test('a source name that needs quotes gets them, and the value still comes from it', () => {
        const author = tab(base('My Sheet'));
        tabEdit(author, cutBlock);
        expect(formulas(author.ctx.sheets)['Two!0_3']).toEqual(["='My Sheet'!A1*2", 10]);
    });

    test('a peer and a joiner land what the author landed', () => {
        const start = base();
        const author = tab(start);
        const peer = tab(start);
        const batch = tabEdit(author, cutBlock);
        tabReceive(peer, batch);

        expect(formulas(peer.ctx.sheets)).toEqual(moved);
        expect(formulas(join(start, [batch]))).toEqual(moved);
    });

    test('an edit of the old sheet reaches the moved formula on the author, a peer and a joiner', () => {
        const start = base();
        const author = tab(start);
        const peer = tab(start);
        const cut = tabEdit(author, cutBlock);
        tabReceive(peer, cut);
        const edit = tabEdit(peer, typeOnFirstSheet('7'));
        tabReceive(author, edit);

        const after = { 'Two!0_3': ['=One!A1*2', 14], 'Two!0_4': ['=D1+1', 15] };
        expect(formulas(peer.ctx.sheets)).toEqual(after);
        expect(formulas(author.ctx.sheets)).toEqual(after);
        expect(formulas(join(start, [cut, edit]))).toEqual(after);
    });

    test('an edit of the new sheet leaves the moved formula alone', () => {
        const author = tab(base());
        tabEdit(author, cutBlock);
        tabEdit(author, (ctx) => {
            ctx.selections = single(0, 0);
            updateCell(ctx, 0, 0, null, '3');
        });
        expect(formulas(author.ctx.sheets)).toEqual(moved);
    });

    test('a formula on the old sheet that read a moved cell recomputes, as the cell it read is empty now', () => {
        const author = tab(base());
        tabEdit(author, (ctx) => {
            ctx.selections = single(0, 1);
            copy(ctx, { cut: true });
            ctx.currentSheetId = 'id_2';
            ctx.selections = single(0, 3);
            pasteCopy(ctx);
        });
        expect(author.ctx.sheets[0].data?.[0][2]?.v).toBe(1);
    });

    test('a moved formula reads the value the block landed on the cell it reads', () => {
        const author = tab(base());
        tabEdit(author, (ctx) => {
            // B1 reads E1, and C1 lands on E1 when B1:C1 lands at D1.
            ctx.selections = single(0, 1);
            updateCell(ctx, 0, 1, null, '=E1');
            ctx.selections = single(0, 2);
            updateCell(ctx, 0, 2, null, '3');
            ctx.selections = [{ row: [0, 0], column: [1, 2], row_focus: 0, column_focus: 1 }];
            copy(ctx, { cut: true });
            ctx.selections = single(0, 3);
            pasteCopy(ctx);
        });
        expect(author.ctx.sheets[0].data?.[0][3]).toMatchObject({ f: '=E1', v: 3 });
    });

    test('a moved range that reached past the block recomputes without the cell that left it', () => {
        const author = tab(base());
        tabEdit(author, (ctx) => {
            ctx.selections = single(0, 2);
            updateCell(ctx, 0, 2, null, '=SUM(A1:B1)');
            ctx.selections = [{ row: [0, 0], column: [1, 2], row_focus: 0, column_focus: 1 }];
            copy(ctx, { cut: true });
            ctx.currentSheetId = 'id_2';
            ctx.selections = single(0, 3);
            pasteCopy(ctx);
        });
        expect(author.ctx.sheets[1].data?.[0][4]).toMatchObject({ f: '=SUM(One!A1:B1)', v: 5 });
    });

    test('an undo and a redo round trip on the author, a peer and a joiner', () => {
        const start = base();
        const author = tab(start);
        const peer = tab(start);
        const cut = tabEdit(author, cutBlock);
        tabReceive(peer, cut);

        const undo = tabUndo(author);
        tabReceive(peer, undo);
        expect(formulas(author.ctx.sheets)).toEqual(before);
        expect(formulas(peer.ctx.sheets)).toEqual(before);
        expect(formulas(join(start, [cut, undo]))).toEqual(before);

        const redo = tabRedo(author);
        tabReceive(peer, redo);
        expect(formulas(author.ctx.sheets)).toEqual(moved);
        expect(formulas(peer.ctx.sheets)).toEqual(moved);
        expect(formulas(join(start, [cut, undo, redo]))).toEqual(moved);
    });

    test('after an undo the restored formula reads its own sheet again', () => {
        const author = tab(base());
        tabEdit(author, cutBlock);
        tabUndo(author);
        tabEdit(author, typeOnFirstSheet('7'));
        expect(formulas(author.ctx.sheets)).toEqual({ 'One!0_1': ['=A1*2', 14], 'One!0_2': ['=B1+1', 15] });
    });
});
