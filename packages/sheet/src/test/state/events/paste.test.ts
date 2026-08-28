// Characterization tests for the paste pipeline (SHEETS-TODO E1). These pin the
// CURRENT contract-level behaviour — resulting cell values / styles / merges /
// conditional-format ranges — so the phase-5 clone-cluster refactors (border C1,
// dropCell C3, selection C4, tokenizer C5) can be gated on them. They assert on
// observable output in the resulting Context, never on internal call sequences.
//
// Entry point: handlePasteByClick(ctx, clipboardData, triggerType?). It is the
// headless-drivable door into the pipeline (handlePaste needs a live ClipboardEvent
// + DOM). When ctx.copyState is set it routes to the internal copy/cut handlers;
// otherwise a plain string goes to the plain-text / formula-string handlers.
//
// The HTML-table paste branch inside handlePaste (real DOM: createElement('div')
// .innerHTML + querySelectorAll + td.style/innerText + CSSOM) and the non-exported
// pasteHandler CellMatrix arm it feeds (paste.ts ~157-283, an independent copy of
// the offsetMC/merge remap) are now covered headless in ./paste-html.test.ts, which
// installs a happy-dom document at module scope. This file stays DOM-free and pins
// the other paste routes: pasteHandlerOfCopyPaste / pasteHandlerOfCutPaste and the
// pasteHandler plain-string branch, entered via handlePasteByClick.

import { describe, expect, it } from 'bun:test';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { handlePasteByClick } from '../../../state/events/paste';
import { copy } from '../../../state/modules/selection';
import { contextFactory } from '../factories/context';

// Explicit selection builders. selectionFactory takes (row, column, ...) as
// [start, end] pairs; hand-writing those inline is error-prone, so name the two
// shapes the paste flow needs.
function single(r: number, c: number) {
    return [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }];
}
function rangeSel(r1: number, r2: number, c1: number, c2: number) {
    return [{ row: [r1, r2], column: [c1, c2], row_focus: r1, column_focus: c1 }];
}

// copy() -> setPendingCopy() extracts plain text via document.createElement and
// writes sessionStorage. Bun's test runtime has neither; widen globalThis with the
// same minimal stubs the sibling clipboard-cut.test.ts uses.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = {
    createElement: () => ({ innerHTML: '', innerText: '', textContent: '' }),
};
g.sessionStorage = { setItem: () => {} };

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
    ctx.selections = source;
    copy(ctx);
    ctx.pasteIsCut = cut;
    ctx.selections = dest;
    handlePasteByClick(ctx, 'internal');
}

describe('plain-text paste (tab/newline matrix)', () => {
    it('fills a 2x2 numeric block and expands the selection to the pasted range', () => {
        const ctx = makeCtx();
        handlePasteByClick(ctx, '1\t2\n3\t4');

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
        handlePasteByClick(ctx, 'foo\tbar');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('foo');
        expect(d[0][1]?.v).toBe('bar');
    });

    it('pastes at the selection anchor, not the origin', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 2);
        handlePasteByClick(ctx, 'x\ty');

        const d = ctx.sheets[0].data!;
        expect(d[2][2]?.v).toBe('x');
        expect(d[2][3]?.v).toBe('y');
        expect(d[0][0]).toBeNull();
    });

    it('skips rows with fewer columns than the first row (ragged-input quirk)', () => {
        // colchelen is fixed by row 0; any later row with fewer tabs is dropped.
        const ctx = makeCtx();
        handlePasteByClick(ctx, '1\t2\n3');

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
        handlePasteByClick(ctx, '00123');

        const d = ctx.sheets[0].data!;
        // stays a string; not parseFloat'd to 123
        expect(d[0][0]?.v).toBe('00123');
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
        ctx.sheets[0].config = {
            borderInfo: [
                {
                    rangeType: 'cell',
                    value: { row_index: 1, col_index: 1, l: side, r: side, t: side, b: side },
                },
            ],
        };

        copyThenPaste(ctx, single(1, 1), single(4, 4));

        // the paste pushes a new cell entry at the destination with the sides
        // computed from the source (getBorderInfoCompute -> paste seam into C1)
        const pushed = ctx.sheets[0].config!.borderInfo!.find(
            (e) => e.rangeType === 'cell' && e.value.row_index === 4 && e.value.col_index === 4,
        );
        expect(pushed).toEqual({
            rangeType: 'cell',
            value: { row_index: 4, col_index: 4, l: side, r: side, t: side, b: side },
        });
        // the source entry is untouched by a copy
        expect(ctx.sheets[0].config!.borderInfo![0]).toEqual({
            rangeType: 'cell',
            value: { row_index: 1, col_index: 1, l: side, r: side, t: side, b: side },
        });
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
        ctx.selections = single(0, 0);
        copy(ctx);
        ctx.pasteIsCut = true;
        ctx.currentSheetId = 'id_1';
        ctx.selections = single(2, 2);
        handlePasteByClick(ctx, 'internal');

        // destination on sheet one filled
        expect(ctx.sheets[0].data![2][2]?.v).toBe('Z');
        // source on sheet two cleared
        expect(ctx.sheets[1].data![0][0]).toBeNull();
    });
});

describe('conditional-format migration on cut/paste (cfSplitRange contract)', () => {
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

        // same-sheet cut uses cfSplitRange 'allPart': the rule range MOVES with
        // the cells — exactly the destination cell, nothing at the source. A
        // refactor that reached for 'restPart' here (empty cellrange = CF
        // silently deleted) must fail this.
        const rule = ctx.sheets[0].conditionalFormatRules![0];
        expect(rule.cellrange).toEqual([{ row: [4, 4], column: [4, 4] }]);
    });
});

describe('partial-merge guard (hasPartMC)', () => {
    it('refuses a plain-text paste that would split a merged cell', () => {
        const ctx = makeCtx(6, 6);
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        // paste a 2x1 block starting inside the merge and crossing its bottom edge
        ctx.selections = single(1, 0);
        handlePasteByClick(ctx, '9\n8');

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
