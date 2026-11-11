// What an opener brings shows in the formula bar as it shows in the cell, in one step with no sync call of its own. An
// opener with no text leaves the bar alone, since it already shows the cell and may hold the caret.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { autoSelectionFormula } from '../../../state/modules/autosum';
import { openCellEditor } from '../../../state/modules/cell-editor';
import { contextFactory, selectionFactory } from '../factories/context';

installHappyDom();

let input: HTMLDivElement;
let bar: HTMLDivElement;
beforeEach(() => {
    input = document.createElement('div');
    input.contentEditable = 'true';
    bar = document.createElement('div');
    bar.contentEditable = 'true';
    document.body.append(input, bar);
});
afterEach(() => {
    input.remove();
    bar.remove();
});

function contextWith(cell: Cell | null): Context {
    const ctx = contextFactory({
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data: [[cell, null]] }],
        selections: selectionFactory([0, 0], [0, 0], 0, 0),
        visibledatarow: [20],
        visibledatacolumn: [74, 148],
        editingCellPosition: [],
    }) as Context;
    ctx.getRefs().cellInput.current = input;
    ctx.getRefs().fxInput.current = bar;
    return ctx;
}

describe('the formula bar mirrors the text an opener brings', () => {
    test('on a closed cell', () => {
        openCellEditor(contextWith(null), 0, 0, { html: '=SUMIF(', caret: 'end' });
        expect(bar.textContent).toBe('=SUMIF(');
    });

    test('over an open edit', () => {
        const ctx = contextWith(null);
        openCellEditor(ctx, 0, 0, { html: '=1+', caret: 'end' });
        openCellEditor(ctx, 0, 0, { html: '=SUMIF(', caret: 'end' });
        expect(input.textContent).toBe('=SUMIF(');
        expect(bar.textContent).toBe('=SUMIF(');
    });

    test('empty, as a typed key opens a filled cell', () => {
        const ctx = contextWith({ v: 'stored', m: 'stored' });
        bar.textContent = 'stored';
        openCellEditor(ctx, 0, 0, { html: '' });
        expect(bar.textContent).toBe('');
    });

    test('an opener with no text leaves the bar and its caret alone, as a click in the bar opens the cell', () => {
        const ctx = contextWith({ v: 'stored', m: 'stored' });
        bar.textContent = 'stored';
        const shown = bar.firstChild;
        openCellEditor(ctx, 0, 0);
        expect(bar.firstChild).toBe(shown);
    });

    test('autosum with nothing to sum', () => {
        autoSelectionFormula(contextWith(null), input, bar, 'SUM');
        expect(input.textContent).toBe('=SUM()');
        expect(bar.textContent).toBe('=SUM()');
    });
});
