// A mousedown on a cell carrying a data-verification affordance, driven through
// handleCellAreaMouseDown itself — the gate under test lives at the callsite, not
// in the predicates the sibling data-verification.test.ts covers.
//
// While a cell edit is open the click belongs to the edit: clicking a tick box to
// put its reference into an `=IF(` being composed used to ALSO toggle the box,
// writing the cell and kicking a recalc behind the half-typed formula. The
// handler needs a real DOM (getBoundingClientRect, window.getSelection, the
// contenteditable the formula is composed in), so this file installs happy-dom at
// module scope the way events/paste-html.test.ts does.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Context } from '../../../state/context';
import { handleCellAreaMouseDown } from '../../../state/events/mouse-cell';
import { cellTextBox, checkboxRect } from '../../../state/modules/data-verification';
import type { DataVerificationRule, GlobalCache } from '../../../state/types';
import { contextFactory } from '../factories/context';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

const TICK_BOX: DataVerificationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };

// A2 carries a tick box holding FALSE; A1 is the cell a formula is composed in.
function tickBoxContext(): Context {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].data = [
        [null, null, null, null],
        [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
    ];
    ctx.sheets[0].dataVerification = { '1_0': TICK_BOX };
    ctx.editingCellPosition = [];
    return ctx;
}

// A2's painted tick box. A2 spans x 0..74, y 20..40; the alignment attrs an
// empty style yields are NaN, the painter's left/middle default.
const PAINTED_BOX = checkboxRect(cellTextBox(0, 20, 74, 40), Number.NaN, Number.NaN);

function mouseDownAt(ctx: Context, x: number, y: number) {
    const container = win.document.createElement('div') as unknown as HTMLDivElement;
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    const cellInput = win.document.createElement('div') as unknown as HTMLDivElement;
    const event = { button: 0, pageX: x, pageY: y, shiftKey: false, preventDefault() {} } as unknown as MouseEvent;
    handleCellAreaMouseDown(ctx, {} as GlobalCache, event, cellInput, container);
}

function mouseDownOnTickBox(ctx: Context) {
    mouseDownAt(ctx, PAINTED_BOX.x + PAINTED_BOX.size / 2, PAINTED_BOX.y + PAINTED_BOX.size / 2);
}

describe('handleCellAreaMouseDown — tick box', () => {
    test('toggles the box when nothing is being edited', () => {
        const ctx = tickBoxContext();
        mouseDownOnTickBox(ctx);
        expect(ctx.sheets[0].data![1][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
    });

    test('answers a click on the painted box edge, not one a pixel above it', () => {
        // The hit test used to rebuild the cell's text box without the painter's
        // 1px top inset, so the box was drawn one pixel below the box that
        // answered a click: its bottom edge was dead and the row above it live.
        const ctx = tickBoxContext();
        mouseDownAt(ctx, PAINTED_BOX.x + PAINTED_BOX.size, PAINTED_BOX.y + PAINTED_BOX.size);
        expect(ctx.sheets[0].data![1][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });

        const above = tickBoxContext();
        mouseDownAt(above, PAINTED_BOX.x, PAINTED_BOX.y - 1);
        expect(above.sheets[0].data![1][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
    });

    test('leaves the box alone while a formula is being composed, and still takes the reference', () => {
        const ctx = tickBoxContext();
        ctx.editingCellPosition = [0, 0];
        ctx.formulaCache.rangestart = true;
        ctx.formulaRangeHighlight = [];

        mouseDownOnTickBox(ctx);

        expect(ctx.sheets[0].data![1][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        // The click did its editing job: A2 is the range the formula picked up.
        expect(ctx.formulaCache.func_selectedrange?.row).toEqual([1, 1]);
        expect(ctx.formulaCache.func_selectedrange?.column).toEqual([0, 0]);
    });
});
