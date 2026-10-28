// A mousedown on a column or row header, driven through the handlers themselves. The menu bar's menus leave the page
// live, so the press that closes one reaches a header too; while a formula waits for a reference it must not put
// `B:B` into it.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Context } from '../../../state/context';
import { handleColumnHeaderMouseDown, handleRowHeaderMouseDown } from '../../../state/events/mouse-header';
import type { GlobalCache } from '../../../state/types';
import { workbookContextFactory } from '../factories/context';

installHappyDom();

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
) {
    const globalCache: GlobalCache = {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set(),
        notifyScrollListeners: () => {},
        pressClosedMenu,
    };
    const container = document.createElement('div');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    let prevented = false;
    const event = new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 30 });
    event.preventDefault = () => {
        prevented = true;
    };
    handler(ctx, globalCache, event, container, document.createElement('div'), null);
    return prevented;
}

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
});
