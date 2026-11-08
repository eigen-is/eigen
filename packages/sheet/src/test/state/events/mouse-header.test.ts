// A mousedown on a column or row header, driven through the handlers themselves. The menu bar's menus leave the page
// live, so the press that closes one reaches a header too; while a formula waits for a reference it must not put
// `B:B` into it.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Context } from '../../../state/context';
import { handleColumnHeaderMouseDown, handleRowHeaderMouseDown } from '../../../state/events/mouse-header';
import { autoFitColumnWidth } from '../../../state/events/mouse-resize';
import type { GlobalCache } from '../../../state/types';
import { workbookContextFactory } from '../factories/context';
import { stubMeasuringCanvas } from '../factories/measuring-canvas';

stubMeasuringCanvas(installHappyDom());

function composingFormula(): Context {
    const ctx = workbookContextFactory();
    ctx.editingCellPosition = [0, 0];
    ctx.formulaCache.rangestart = true;
    ctx.formulaRangeHighlight = [];
    return ctx;
}

function press(
    handler: typeof handleColumnHeaderMouseDown | typeof handleRowHeaderMouseDown,
    ctx: Context,
    pressClosedMenu: boolean,
    cellInput = document.createElement('div'),
) {
    const globalCache: GlobalCache = {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set(),
        pressClosedMenu,
    };
    const container = document.createElement('div');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    let prevented = false;
    const event = new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 30 });
    event.preventDefault = () => {
        prevented = true;
    };
    handler(ctx, globalCache, event, container, cellInput, null);
    return prevented;
}

test('a double-click on a column edge fits the column to its widest text', () => {
    const ctx = workbookContextFactory();
    ctx.sheets[0].data = [[{ v: 'abc', m: 'abc' }], [{ v: 'abcdefgh', m: 'abcdefgh' }]];
    autoFitColumnWidth(ctx, 0);
    // The stub draws a glyph 7 px wide, and the fit pads the text by 14.
    expect(ctx.sheets[0].config?.columnlen?.[0]).toBe(8 * 7 + 14);
});

describe.each([
    ['column', handleColumnHeaderMouseDown],
    ['row', handleRowHeaderMouseDown],
])('a press on a %s header', (_name, handler) => {
    test('that closes a menu puts no reference into the formula being composed, and keeps the focus', () => {
        const ctx = composingFormula();
        expect(press(handler, ctx, true)).toBe(true);
        expect(ctx.formulaCache.func_selectedrange).toBeUndefined();
    });

    test('with no menu open still takes the reference', () => {
        const ctx = composingFormula();
        press(handler, ctx, false);
        expect(ctx.formulaCache.func_selectedrange).toBeDefined();
    });

    test('commits the open edit and grows its row to the text', () => {
        const ctx = workbookContextFactory();
        ctx.editingCellPosition = [0, 0];
        const input = document.createElement('div');
        input.innerHTML = 'line one\nline two\nline three';
        press(handler, ctx, false, input);
        expect(ctx.sheets[0].config?.rowlen?.[0]).toBeGreaterThan(ctx.defaultrowlen);
    });
});
