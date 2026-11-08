// A commit or a Wrap grows the row to the wrapped text. The height it stores is judged by the painter's own layout: in
// the cell's text box, every line of the text fits. A height from a wider box than the painter's comes out one line
// short and clips the first and the last line.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { produce } from 'immer';
import type { Context } from '../../../state/context';
import { getFlowdata } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import { cellTextBox } from '../../../state/modules/data-validation';
import { clearMeasureTextCache, getCellTextInfo, measuringContext } from '../../../state/modules/text';
import { updateFormat } from '../../../state/modules/toolbar';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';
import { stubMeasuringCanvas } from '../factories/measuring-canvas';

const win = installHappyDom();
const ASCENT = 10;
const DESCENT = 3;
stubMeasuringCanvas(win, ASCENT, DESCENT);

const COLUMN = 100;
// Fourteen characters are 98 px, which a 100 px box takes and the painter's 98 px box doesn't.
const TEXT = 'abcdefghijklm abcdefghijklm abcdefghijklm abcdefghijklm abcdefghijklm';

function sheetWith(cell: Cell | null, rowlen?: number): Context {
    const ctx = contextFactory({
        editingCellPosition: [],
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    }) as Context;
    ctx.sheets[0].data = [[cell, null]];
    ctx.sheets[0].config = rowlen ? { rowlen: { 0: rowlen } } : {};
    ctx.defaultrowlen = 20;
    ctx.defaultcollen = COLUMN;
    clearMeasureTextCache();
    return ctx;
}

function input(text: string) {
    const element = win.document.createElement('div');
    element.textContent = text;
    return element as unknown as HTMLDivElement;
}

const committed = (ctx: Context, text: string) =>
    produce(ctx, (draft: Context) => updateCell(draft, 0, 0, input(text)));

// Whether the painter draws the first cell's every line inside its box, at the height the row stored.
function linesFit(ctx: Context) {
    const cell = ctx.sheets[0].data?.[0][0];
    const measuring = measuringContext();
    if (!cell || !measuring) throw new Error('no cell to lay out');
    const rowlen = ctx.sheets[0].config?.rowlen?.[0] ?? ctx.defaultrowlen;
    const { width, height } = cellTextBox(0, 0, COLUMN, rowlen);
    const all = getCellTextInfo(cell, measuring, { r: 0, c: 0, cellWidth: width })?.values ?? [];
    const painted =
        getCellTextInfo(cell, measuring, { r: 0, c: 0, cellWidth: width, cellHeight: height })?.values ?? [];
    const tops = painted.map(({ top }) => top);
    return {
        lines: painted.length,
        wanted: all.length,
        above: Math.min(...tops) - ASCENT,
        below: height - (Math.max(...tops) + DESCENT),
    };
}

describe('a wrapped cell fits its row', () => {
    test('a commit grows the row to the lines the painter draws', () => {
        const fit = linesFit(committed(sheetWith({ tb: '2' }), TEXT));
        expect(fit.lines).toBe(fit.wanted);
        expect(fit.above).toBeGreaterThanOrEqual(0);
        expect(fit.below).toBeGreaterThanOrEqual(0);
    });

    test('Wrap grows the row to the same height a commit does', () => {
        const wrapped = produce(sheetWith({ v: TEXT, m: TEXT, ct: { fa: 'General', t: 'g' } }), (draft: Context) => {
            const d = getFlowdata(draft);
            if (d) updateFormat(draft, input(''), d, 'tb', 'wrap');
        });
        const typed = committed(sheetWith({ tb: '2' }), TEXT);
        expect(wrapped.sheets[0].config?.rowlen?.[0]).toBe(typed.sheets[0].config?.rowlen?.[0]);
    });

    test('a row grown once grows again for a longer text', () => {
        const once = committed(sheetWith({ tb: '2' }), TEXT);
        const twice = committed(once, `${TEXT} ${TEXT}`);
        const [first, second] = [once, twice].map((ctx) => ctx.sheets[0].config?.rowlen?.[0] ?? 0);
        expect(second).toBeGreaterThan(first);
    });

    test('a shorter commit keeps a row another cell may need', () => {
        const ctx = committed(sheetWith({ tb: '2' }, 300), TEXT);
        expect(ctx.sheets[0].config?.rowlen?.[0]).toBe(300);
    });

    test('a row someone sized by hand stays', () => {
        const sized = sheetWith({ tb: '2' }, 30);
        sized.sheets[0].config = { rowlen: { 0: 30 }, customHeight: { 0: 1 } };
        const ctx = committed(sized, TEXT);
        expect(ctx.sheets[0].config?.rowlen?.[0]).toBe(30);
    });
});
