// Characterization tests for the paste pipeline (SHEETS-TODO E1). These pin the
// CURRENT contract-level behavior — resulting cell values / styles / merges /
// conditional-format ranges — so the phase-5 clone-cluster refactors (border C1,
// dropCell C3, selection C4, tokenizer C5) can be gated on them. They assert on
// observable output in the resulting Context, never on internal call sequences.
//
// The entry points are pasteCopy, a paste of the workbook's own copy, and pasteText, plain text or a formula from
// elsewhere. A pasted HTML table is covered in ./paste-html.test.ts, which installs a happy-dom document. This file
// stays DOM-free.

import { describe, expect, it } from 'bun:test';
import type { Cell, DefaultConditionalFormatRule } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { copy } from '../../../state/modules/selection';
import { pasteCopy, pasteText } from '../factories/clipboard';
import { contextFactory, editInPlace } from '../factories/context';
import { edit, typed } from '../factories/edit-cycle';

// Explicit selection builders. selectionFactory takes (row, column, ...) as
// [start, end] pairs; hand-writing those inline is error-prone, so name the two
// shapes the paste flow needs.
function single(r: number, c: number) {
    return [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }];
}
function rangeSel(r1: number, r2: number, c1: number, c2: number) {
    return [{ row: [r1, r2], column: [c1, c2], row_focus: r1, column_focus: c1 }];
}

function grid(rows: number, cols: number): (Cell | null)[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

// A single-sheet ctx with an explicit rows x cols grid, selection anchored at (0,0).
function makeCtx(rows = 8, cols = 8, cells?: (data: (Cell | null)[][]) => void): Context {
    const data = grid(rows, cols);
    cells?.(data);
    return contextFactory({
        currentSheetId: 'id_1',
        selections: single(0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data }],
    }) as Context;
}

// Drive the real user flow: select source, copy (populates ctx.copyState via the
// clipboard path), then move the selection to the destination and paste.
function copyThenPaste(
    ctx: Context,
    source: ReturnType<typeof single>,
    dest: ReturnType<typeof single>,
    { cut = false }: { cut?: boolean } = {},
) {
    editInPlace(ctx, (draft) => {
        draft.selections = source;
        copy(draft, { cut });
        draft.selections = dest;
        pasteCopy(draft);
    });
}

// A paste past the last row or column grows the grid, and the sheet's size grows with it: a stored snapshot keeps the
// size, so a size behind the cells would cut the pasted rows off the next snapshot.
describe('a paste past the grid grows the sheet size with it', () => {
    const size = (ctx: Context) => [ctx.sheets[0].row, ctx.sheets[0].column];

    it('for plain text', () => {
        const ctx = makeCtx();
        ctx.selections = single(7, 7);
        pasteText(ctx, '1\t2\n3\t4');
        expect(size(ctx)).toEqual([9, 9]);
    });

    it('for a copy and a cut', () => {
        for (const cut of [false, true]) {
            const ctx = makeCtx(8, 8, (d) => {
                d[0][0] = { v: 1, m: '1' };
                d[1][1] = { v: 2, m: '2' };
            });
            copyThenPaste(ctx, rangeSel(0, 1, 0, 1), single(7, 7), { cut });
            expect(size(ctx)).toEqual([9, 9]);
        }
    });
});

describe('plain-text paste (tab/newline matrix)', () => {
    it('fills a 2x2 numeric block and expands the selection to the pasted range', () => {
        const ctx = makeCtx();
        pasteText(ctx, '1\t2\n3\t4');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe(1);
        expect(d[0][1]?.v).toBe(2);
        expect(d[1][0]?.v).toBe(3);
        expect(d[1][1]?.v).toBe(4);
        // numeric-looking text is coerced to a number, display string kept
        expect(d[0][0]?.m).toBe('1');
        // selection grows to cover the whole pasted rectangle
        expect(ctx.selections![0].row).toEqual([0, 1]);
        expect(ctx.selections![0].column).toEqual([0, 1]);
    });

    it('keeps non-numeric cells as strings', () => {
        const ctx = makeCtx();
        pasteText(ctx, 'foo\tbar');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('foo');
        expect(d[0][1]?.v).toBe('bar');
    });

    it('pastes at the selection anchor, not the origin', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 2);
        pasteText(ctx, 'x\ty');

        const d = ctx.sheets[0].data!;
        expect(d[2][2]?.v).toBe('x');
        expect(d[2][3]?.v).toBe('y');
        expect(d[0][0]).toBeNull();
    });

    it('skips rows with fewer columns than the first row (ragged-input quirk)', () => {
        // colchelen is fixed by row 0; any later row with fewer tabs is dropped.
        const ctx = makeCtx();
        pasteText(ctx, '1\t2\n3');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe(1);
        expect(d[0][1]?.v).toBe(2);
        // the short second row never lands
        expect(d[1][0]).toBeNull();
        expect(ctx.selections![0].row).toEqual([0, 0]);
    });

    it('does not coerce numbers into a text-formatted (@) target cell', () => {
        const ctx = makeCtx(4, 4, (d) => {
            d[0][0] = { v: '', m: '', ct: { fa: '@', t: 's' } };
        });
        pasteText(ctx, '00123');

        const d = ctx.sheets[0].data!;
        // stays a string; not parseFloat'd to 123
        expect(d[0][0]?.v).toBe('00123');
    });

    it('parses pasted text the way typed entry does', () => {
        const ctx = makeCtx(4, 4, (d) => {
            d[0][1] = { v: 1, m: '1.00', ct: { fa: '0.00', t: 'n' } };
            d[0][2] = { v: 45000, m: '15/03/2023', ct: { fa: 'dd/mm/yyyy', t: 'd' } };
            d[0][3] = { f: '=A1', v: 5, m: '5' };
        });
        pasteText(ctx, '0x10\t0x10\t2024-05-06\t1,234.5');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('0x10');
        expect(d[0][1]?.v).toBe('0x10');
        expect(d[0][2]).toMatchObject({ v: 45418, m: '06/05/2024', ct: { fa: 'dd/mm/yyyy', t: 'd' } });
        expect(d[0][3]?.v).toBe(1234.5);
        expect(d[0][3]?.f).toBeUndefined();
    });
});

describe('formula paste — relative refs shift, absolute refs stay (C5 tokenizer contract)', () => {
    it('shifts a relative ref down when pasted one row lower (=A1 -> =A2)', () => {
        const ctx = makeCtx(6, 6, (d) => {
            d[0][0] = { v: 5, m: '5' };
            d[1][1] = { f: '=A1', v: 5, m: '5' };
        });
        copyThenPaste(ctx, single(1, 1), single(2, 1));

        expect(ctx.sheets[0].data![2][1]?.f).toBe('=A2');
    });

    it('shifts a relative ref right when pasted one column over (=A1 -> =B1)', () => {
        const ctx = makeCtx(6, 6, (d) => {
            d[1][1] = { f: '=A1', v: 0, m: '0' };
        });
        copyThenPaste(ctx, single(1, 1), single(1, 2));

        expect(ctx.sheets[0].data![1][2]?.f).toBe('=B1');
    });

    it('leaves an absolute ref untouched ($A$1 stays $A$1)', () => {
        const ctx = makeCtx(6, 6, (d) => {
            d[0][0] = { v: 5, m: '5' };
            d[1][1] = { f: '=$A$1', v: 5, m: '5' };
        });
        copyThenPaste(ctx, single(1, 1), single(3, 3));

        expect(ctx.sheets[0].data![3][3]?.f).toBe('=$A$1');
    });

    it('shifts only the relative axis of a mixed ref ($A1 -> $A2 moving down)', () => {
        const ctx = makeCtx(6, 6, (d) => {
            d[1][1] = { f: '=$A1', v: 0, m: '0' };
        });
        copyThenPaste(ctx, single(1, 1), single(2, 1));

        expect(ctx.sheets[0].data![2][1]?.f).toBe('=$A2');
    });

    it('shifts a relative ref up and left when pasted above-left (=D4 -> =C3)', () => {
        // negative offsets run the Math.abs 'up'/'left' functionCopy branches;
        // a sign inversion there would go unnoticed by the down/right cases.
        const ctx = makeCtx(6, 6, (d) => {
            d[2][2] = { f: '=D4', v: 0, m: '0' };
        });
        copyThenPaste(ctx, single(2, 2), single(1, 1));

        expect(ctx.sheets[0].data![1][1]?.f).toBe('=C3');
    });

    it('shifts both axes of a range at once, re-sorting legs that cross', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { f: '=SUM(A1:A$1)', v: 0, m: '0' };
            d[1][2] = { f: '=SUM(A1:$B$2)', v: 0, m: '0' };
        });
        copyThenPaste(ctx, single(1, 1), single(4, 2));
        copyThenPaste(ctx, single(1, 2), single(3, 5));

        expect(ctx.sheets[0].data![4][2]?.f).toBe('=SUM(B$1:B4)');
        expect(ctx.sheets[0].data![3][5]?.f).toBe('=SUM($B$2:D3)');
    });
});

describe('internal copy/paste — styles and merges', () => {
    it('carries cell styles to the destination', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 7, m: '7', bg: '#ED7D31', bl: 1, fc: '#ff0000', it: 1 };
        });
        copyThenPaste(ctx, single(1, 1), single(4, 4));

        const dest = ctx.sheets[0].data![4][4]!;
        expect(dest.v).toBe(7);
        expect(dest.bg).toBe('#ED7D31');
        expect(dest.bl).toBe(1);
        expect(dest.fc).toBe('#ff0000');
        expect(dest.it).toBe(1);
    });

    it('copies a 2x2 merged block, re-anchoring the merge at the destination', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'M', m: 'M', mc: { r: 1, c: 1, rs: 2, cs: 2 } };
            d[1][2] = { mc: { r: 1, c: 1 } };
            d[2][1] = { mc: { r: 1, c: 1 } };
            d[2][2] = { mc: { r: 1, c: 1 } };
        });
        ctx.sheets[0].config = { merge: { '1_1': { r: 1, c: 1, rs: 2, cs: 2 } } };

        copyThenPaste(ctx, rangeSel(1, 2, 1, 2), single(4, 4));

        const d = ctx.sheets[0].data!;
        // copy (not cut): the source merge survives alongside the new one
        expect(ctx.sheets[0].config!.merge).toEqual({
            '1_1': { r: 1, c: 1, rs: 2, cs: 2 },
            '4_4': { r: 4, c: 4, rs: 2, cs: 2 },
        });
        expect(d[4][4]?.mc).toEqual({ r: 4, c: 4, rs: 2, cs: 2 });
        expect(d[4][5]?.mc).toEqual({ r: 4, c: 4 });
        expect(d[5][4]?.mc).toEqual({ r: 4, c: 4 });
        expect(d[5][5]?.mc).toEqual({ r: 4, c: 4 });
    });

    it('carries a cell border to the destination via config.borderInfo (C1 border seam)', () => {
        const side = { color: '#0000ff', style: 1 };
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'B', m: 'B' };
        });
        const sides = { l: side, r: side, t: side, b: side };
        ctx.sheets[0].config = { borderInfo: { '1_1': sides } };

        copyThenPaste(ctx, single(1, 1), single(4, 4));

        // the paste writes the destination key with the sides computed from the source
        // (getBorderInfoCompute -> paste seam into C1); the source entry is untouched by a copy
        expect(ctx.sheets[0].config!.borderInfo).toEqual({ '1_1': sides, '4_4': sides });
    });

    it('a plain-text paste keeps the destination border (only the HTML path carries borders)', () => {
        const side = { color: '#0000ff', style: 1 };
        const ctx = makeCtx();
        const sides = { l: side, r: side, t: side, b: side };
        ctx.sheets[0].config = { borderInfo: { '0_0': sides } };

        pasteText(ctx, '1\t2\n3\t4');

        expect(ctx.sheets[0].data![0][0]?.v).toBe(1);
        expect(ctx.sheets[0].config!.borderInfo).toEqual({ '0_0': sides });
    });

    it('pasting a borderless cell clears the destination border', () => {
        const side = { color: '#0000ff', style: 1 };
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'B', m: 'B' };
        });
        ctx.sheets[0].config = { borderInfo: { '4_4': { l: side, r: side, t: side, b: side } } };

        copyThenPaste(ctx, single(1, 1), single(4, 4));

        expect(ctx.sheets[0].config!.borderInfo).toEqual({});
    });

    it('tiles the copy block across a destination that is an integer multiple', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 10, m: '10' };
            d[1][2] = { v: 20, m: '20' };
        });
        // copy 1x2, paste into a 1x4 selection -> repeats twice horizontally
        copyThenPaste(ctx, rangeSel(1, 1, 1, 2), rangeSel(3, 3, 1, 4));

        const d = ctx.sheets[0].data!;
        expect(d[3][1]?.v).toBe(10);
        expect(d[3][2]?.v).toBe(20);
        expect(d[3][3]?.v).toBe(10);
        expect(d[3][4]?.v).toBe(20);
    });
});

describe('cut/paste — cross-range move', () => {
    it('clears the source and fills the destination on the same sheet', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'X', m: 'X' };
        });
        copyThenPaste(ctx, single(1, 1), single(4, 4), {
            cut: true,
        });

        const d = ctx.sheets[0].data!;
        expect(d[1][1]).toBeNull();
        expect(d[4][4]?.v).toBe('X');
        // selection follows the moved block
        expect(ctx.selections![0].row).toEqual([4, 4]);
        expect(ctx.selections![0].column).toEqual([4, 4]);
    });

    it('migrates a merge from source to destination (removing the source merge entry)', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'M', m: 'M', mc: { r: 1, c: 1, rs: 2, cs: 2 } };
            d[1][2] = { mc: { r: 1, c: 1 } };
            d[2][1] = { mc: { r: 1, c: 1 } };
            d[2][2] = { mc: { r: 1, c: 1 } };
        });
        ctx.sheets[0].config = { merge: { '1_1': { r: 1, c: 1, rs: 2, cs: 2 } } };

        copyThenPaste(ctx, rangeSel(1, 2, 1, 2), single(4, 4), {
            cut: true,
        });

        const merge = ctx.sheets[0].config!.merge!;
        expect(merge['1_1']).toBeUndefined();
        expect(merge['4_4']).toEqual({ r: 4, c: 4, rs: 2, cs: 2 });
        expect(ctx.sheets[0].data![1][1]).toBeNull();
    });

    it('moves cells across sheets, clearing the source sheet and filling the current one', () => {
        const data1 = grid(6, 6);
        const data2 = grid(6, 6);
        data2[0][0] = { v: 'Z', m: 'Z' };
        const ctx = contextFactory({
            currentSheetId: 'id_2',
            selections: single(0, 0),
            sheets: [
                { name: 'one', id: 'id_1', order: 0, data: data1 },
                { name: 'two', id: 'id_2', order: 1, data: data2 },
            ],
        }) as Context;

        // copy from sheet two, switch to sheet one, cut-paste
        editInPlace(ctx, (draft) => {
            draft.selections = single(0, 0);
            copy(draft, { cut: true });
            draft.currentSheetId = 'id_1';
            draft.selections = single(2, 2);
            pasteCopy(draft);
        });

        // destination on sheet one filled
        expect(ctx.sheets[0].data![2][2]?.v).toBe('Z');
        // source on sheet two cleared
        expect(ctx.sheets[1].data![0][0]).toBeNull();
    });
});

describe('conditional-format migration on cut/paste', () => {
    it('drops the cut cells from a same-sheet CF rule range', () => {
        const ctx = makeCtx(8, 8, (d) => {
            d[1][1] = { v: 'C', m: 'C' };
        });
        ctx.sheets[0].conditionalFormatRules = [
            {
                type: 'default',
                cellrange: [{ row: [1, 1], column: [1, 1] }],
                format: { cellColor: '#ff0000' },
                conditionName: 'greaterThan',
                conditionValue: [0],
            },
        ];

        copyThenPaste(ctx, single(1, 1), single(4, 4), {
            cut: true,
        });

        // same-sheet cut: the rule range MOVES with
        // the cells — exactly the destination cell, nothing at the source. A
        // refactor that reached for 'restPart' here (empty cellrange = CF
        // silently deleted) must fail this.
        const rule = ctx.sheets[0].conditionalFormatRules![0];
        expect(rule.cellrange).toEqual([{ row: [4, 4], column: [4, 4] }]);
    });

    // A formula rule reads relative to its first range's top-left, so a paste that moves
    // that corner must re-express the formula for every cell to read what it read before.
    const formulaRule = (): DefaultConditionalFormatRule => ({
        type: 'default',
        cellrange: [{ row: [1, 5], column: [1, 1] }],
        format: { cellColor: '#ff0000' },
        conditionName: 'formula',
        conditionValue: ['=B2>1'],
    });

    const twoSheets = () =>
        contextFactory({
            currentSheetId: 'id_2',
            selections: single(0, 0),
            sheets: [
                { name: 'one', id: 'id_1', order: 0, data: grid(12, 8) },
                { name: 'two', id: 'id_2', order: 1, data: grid(12, 8) },
            ],
        }) as Context;
    const crossSheetPaste = (ctx: Context, cut: boolean) => {
        ctx.selections = rangeSel(1, 5, 1, 1);
        copy(ctx, { cut });
        ctx.currentSheetId = 'id_1';
        ctx.selections = single(1, 1);
        pasteCopy(ctx);
    };

    it('takes only the pasted cells out of the target sheet rules when the copied cells carry none', () => {
        const ctx = twoSheets();
        const far = { ...formulaRule(), cellrange: [{ row: [9, 9], column: [3, 3] }] };
        ctx.sheets[0].conditionalFormatRules = [
            { ...formulaRule(), cellrange: [{ row: [1, 7], column: [1, 1] }] },
            far,
        ];

        crossSheetPaste(ctx, false);

        expect(ctx.sheets[0].conditionalFormatRules).toEqual([
            { ...formulaRule(), cellrange: [{ row: [6, 7], column: [1, 1] }], conditionValue: ['=B7>1'] },
            far,
        ]);
    });

    it('moves a whole rule cut to a sheet without rules, leaving no empty rule behind', () => {
        const ctx = twoSheets();
        ctx.sheets[1].conditionalFormatRules = [formulaRule()];

        crossSheetPaste(ctx, true);

        expect(ctx.sheets[0].conditionalFormatRules).toEqual([formulaRule()]);
        expect(ctx.sheets[1].conditionalFormatRules).toEqual([]);
    });

    it('re-expresses a formula rule whose top rows are cut away', () => {
        const ctx = makeCtx(12, 8);
        ctx.sheets[0].conditionalFormatRules = [formulaRule()];

        copyThenPaste(ctx, rangeSel(1, 2, 1, 1), single(7, 4), { cut: true });

        expect(ctx.sheets[0].conditionalFormatRules).toEqual([
            {
                ...formulaRule(),
                cellrange: [
                    { row: [3, 5], column: [1, 1] },
                    { row: [7, 8], column: [4, 4] },
                ],
                conditionValue: ['=B4>1'],
            },
        ]);
    });

    it('joins a copy from the middle of a formula rule, so each cell reads as it did', () => {
        const ctx = makeCtx(12, 8);
        ctx.sheets[0].conditionalFormatRules = [formulaRule()];

        copyThenPaste(ctx, single(2, 1), single(5, 4));

        // The rule keeps its corner and its text: at E6 it reads E6, four rows down and three across from B2.
        expect(ctx.sheets[0].conditionalFormatRules).toEqual([
            {
                ...formulaRule(),
                cellrange: [
                    { row: [1, 5], column: [1, 1] },
                    { row: [5, 5], column: [4, 4] },
                ],
            },
        ]);
    });
});

describe('a paste over a whole merge replaces it', () => {
    const merged = () => {
        const ctx = makeCtx(4, 4, (d) => {
            d[0][0] = { v: 'a', m: 'a', mc: { r: 0, c: 0, rs: 1, cs: 2 } };
            d[0][1] = { mc: { r: 0, c: 0 } };
        });
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } } };
        return ctx;
    };

    it('for plain text, whose second value shows', () => {
        const ctx = merged();
        pasteText(ctx, 'x\ty');

        expect(ctx.sheets[0].config?.merge).toEqual({});
        const d = ctx.sheets[0].data!;
        expect(d[0][0]).toMatchObject({ v: 'x' });
        expect(d[0][0]?.mc).toBeUndefined();
        expect(d[0][1]).toMatchObject({ v: 'y' });
        expect(d[0][1]?.mc).toBeUndefined();
    });
});

describe('partial-merge guard (hasPartMC)', () => {
    it('refuses a plain-text paste that would split a merged cell', () => {
        const ctx = makeCtx(6, 6);
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        // paste a 2x1 block starting inside the merge and crossing its bottom edge
        ctx.selections = single(1, 0);
        pasteText(ctx, '9\n8');

        const d = ctx.sheets[0].data!;
        // nothing written — the guard bailed out
        expect(d[1][0]).toBeNull();
        expect(d[2][0]).toBeNull();
    });
});

describe('copy/paste round-trip (item 6)', () => {
    it('a styled range pasted elsewhere equals the source in values and styles', () => {
        const styled = (v: string): Cell => ({ v, m: v, bg: '#ED7D31', bl: 1, fc: '#0000ff' });
        const ctx = makeCtx(10, 10, (d) => {
            d[1][1] = styled('a');
            d[1][2] = styled('b');
            d[2][1] = styled('c');
            d[2][2] = styled('d');
        });

        copyThenPaste(ctx, rangeSel(1, 2, 1, 2), single(6, 6));

        const d = ctx.sheets[0].data!;
        const pick = (c: Cell | null) => c && { v: c.v, m: c.m, bg: c.bg, bl: c.bl, fc: c.fc };
        expect(pick(d[6][6])).toEqual(pick(d[1][1]));
        expect(pick(d[6][7])).toEqual(pick(d[1][2]));
        expect(pick(d[7][6])).toEqual(pick(d[2][1]));
        expect(pick(d[7][7])).toEqual(pick(d[2][2]));
    });
});

describe('pasted formulas and the dependency map', () => {
    const pasteTextAt = (text: string, r: number, c: number) => (d: Context) => {
        d.selections = single(r, c);
        pasteText(d, text);
    };

    for (const warm of [false, true]) {
        it(`a pasted formula string recalcs when its precedent changes (${warm ? 'warm' : 'cold'} map)`, () => {
            let ctx = makeCtx(6, 6, (d) => {
                d[0][0] = { v: 5, m: '5' };
            });
            if (warm) warmFormulaCellInfoMap(ctx);

            [ctx] = edit(ctx, pasteTextAt('=A1*3', 0, 2));
            expect(ctx.sheets[0].data![0][2]?.v).toBe(15);
            [ctx] = edit(ctx, typed(0, 0, '2'));

            expect(ctx.sheets[0].data![0][2]?.v).toBe(6);
        });
    }

    // One!A1 = 5, One!B1 = =A1*2, Two!A1 = 100; B1 is cut from One and pasted at Two!D1.
    function cutAcrossSheets(): Context {
        const one = grid(6, 6);
        one[0][0] = { v: 5, m: '5' };
        one[0][1] = { f: '=A1*2', v: 10, m: '10' };
        const two = grid(6, 6);
        two[0][0] = { v: 100, m: '100' };
        const base = contextFactory({
            currentSheetId: 'id_1',
            selections: single(0, 0),
            sheets: [
                { name: 'One', id: 'id_1', order: 0, data: one },
                { name: 'Two', id: 'id_2', order: 1, data: two },
            ],
        }) as Context;
        warmFormulaCellInfoMap(base);
        const [ctx] = edit(base, (d) => {
            d.selections = single(0, 1);
            copy(d, { cut: true });
            d.currentSheetId = 'id_2';
            d.selections = single(0, 3);
            pasteCopy(d);
        });
        return ctx;
    }

    it('a formula cut to another sheet is not resurrected by its old precedent', () => {
        let ctx = cutAcrossSheets();
        expect(ctx.sheets[0].data![0][1]).toBeNull();

        [ctx] = edit(ctx, (d) => {
            d.currentSheetId = 'id_1';
            typed(0, 0, '7')(d);
        });

        expect(ctx.sheets[0].data![0][1]).toBeNull();
    });

    it('a formula cut to another sheet keeps reading the cell it read', () => {
        const ctx = cutAcrossSheets();

        const cell = ctx.sheets[1].data![0][3];
        expect(cell?.f).toBe('=One!A1*2');
        expect(cell?.v).toBe(10);
        expect(cell?.m).toBe('10');
    });

    it('a same-sheet cut keeps the formula value and recalcs the vacated cell dependents', () => {
        const base = makeCtx(6, 6, (d) => {
            d[0][0] = { v: 5, m: '5' };
            d[0][1] = { f: '=A1*2', v: 10, m: '10' };
            d[0][2] = { f: '=B1+1', v: 11, m: '11' };
        });
        warmFormulaCellInfoMap(base);
        const [ctx] = edit(base, (d) => copyThenPaste(d, single(0, 1), single(3, 3), { cut: true }));

        const data = ctx.sheets[0].data!;
        expect(data[3][3]?.v).toBe(10);
        expect(data[0][2]?.v).toBe(1);
    });

    it("a formula cut to another sheet recalcs when the cell it reads changes, not the new sheet's", () => {
        let ctx = cutAcrossSheets();

        [ctx] = edit(ctx, typed(0, 0, '3'));
        expect(ctx.sheets[1].data![0][3]?.v).toBe(10);

        [ctx] = edit(ctx, (d) => {
            d.currentSheetId = 'id_1';
            typed(0, 0, '7')(d);
        });
        expect(ctx.sheets[1].data![0][3]?.v).toBe(14);
    });
});

describe('hyperlinks travel with an internal paste', () => {
    const link = { linkType: 'webpage', linkAddress: 'https://eigen.is' };
    function linkedCtx() {
        const ctx = makeCtx(6, 6, (d) => {
            d[0][0] = { v: 'site', m: 'site', hl: { r: 0, c: 0, id: 'id_1' } };
        });
        ctx.sheets[0].hyperlink = { '0_0': link };
        return ctx;
    }

    it('a copied link lands on the pasted cell', () => {
        const ctx = linkedCtx();
        copyThenPaste(ctx, single(0, 0), single(2, 2));
        expect(ctx.sheets[0].hyperlink?.['2_2']).toEqual(link);
    });

    it('a cut link lands on the pasted cell and leaves the vacated one', () => {
        const ctx = linkedCtx();
        copyThenPaste(ctx, single(0, 0), single(2, 2), { cut: true });
        expect(ctx.sheets[0].hyperlink?.['2_2']).toEqual(link);
        expect(ctx.sheets[0].hyperlink?.['0_0']).toBeUndefined();
    });
});
