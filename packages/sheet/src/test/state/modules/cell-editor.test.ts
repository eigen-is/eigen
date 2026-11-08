// openCellEditor fills the editor inside the opener's recipe. Cell text is anyone's, so it must arrive escaped, while a
// formula and rich text arrive as the markup we built for them.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { openCellEditor } from '../../../state/modules/cell-editor';
import { contextFactory } from '../factories/context';

installHappyDom();

let input: HTMLDivElement;
beforeEach(() => {
    input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
});
afterEach(() => input.remove());

function contextWith(cell: Cell | null): Context {
    const ctx = contextFactory({
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                data: [
                    [cell, { v: 'other', m: 'other' }],
                    [null, null],
                ],
            },
        ],
        visibledatarow: [20, 40],
        visibledatacolumn: [74, 148],
    }) as Context;
    ctx.editingCellPosition = [];
    ctx.getRefs().cellInput.current = input;
    return ctx;
}

function textBeforeCaret() {
    const caret = document.getSelection()?.getRangeAt(0);
    if (!caret) throw new Error('no caret');
    const before = document.createRange();
    before.setStart(input, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    return before.toString();
}

test('cell text that reads as markup stays text', () => {
    const text = '<img src=q onerror=alert(1)>';
    openCellEditor(contextWith({ v: text, m: text }), 0, 0);
    expect(input.querySelector('img')).toBeNull();
    expect(input.textContent).toBe(text);
});

test('a formula opens as colored references and draws their highlights', () => {
    const ctx = contextWith({ f: '=B1', v: 'other', m: 'other' });
    openCellEditor(ctx, 0, 0);
    expect(input.querySelector('.sheet-formula-functionrange-cell')?.textContent).toBe('B1');
    expect(input.textContent).toBe('=B1');
    expect(ctx.formulaRangeHighlight).toHaveLength(1);
});

test('rich text opens as its runs', () => {
    const cell: Cell = {
        ct: {
            fa: 'General',
            t: 'inlineStr',
            s: [{ v: 'bold', bl: 1 }, { v: ' plain' }],
        },
    };
    openCellEditor(contextWith(cell), 0, 0);
    expect(input.querySelectorAll('span')).toHaveLength(2);
    expect(input.textContent).toBe('bold plain');
});

test('it loads the cell it opens on, not the first selection', () => {
    const ctx = contextWith({ v: 'first', m: 'first' });
    openCellEditor(ctx, 0, 1);
    expect(input.textContent).toBe('other');
});

test('the caret is at the end as the recipe returns, so a fast key lands after the text', () => {
    openCellEditor(contextWith({ v: 'hello', m: 'hello' }), 0, 0, { caret: 'end' });
    expect(document.activeElement).toBe(input);
    expect(textBeforeCaret()).toBe('hello');
});

test('without a caret the focus stays where it is, as in the formula bar', () => {
    const bar = document.createElement('div');
    bar.tabIndex = 0;
    document.body.append(bar);
    bar.focus();
    openCellEditor(contextWith({ v: 'hello', m: 'hello' }), 0, 0);
    expect(document.activeElement).toBe(bar);
    expect(input.textContent).toBe('hello');
    bar.remove();
});

test('an open editor keeps the typed text when an opener brings no text of its own', () => {
    const ctx = contextWith({ v: 'stored', m: 'stored' });
    openCellEditor(ctx, 0, 0);
    input.textContent = 'typed';
    openCellEditor(ctx, 0, 0, { caret: 'end' });
    expect(input.textContent).toBe('typed');
});

test('an opener that brings its text replaces an open edit', () => {
    const ctx = contextWith({ v: 'stored', m: 'stored' });
    openCellEditor(ctx, 0, 0);
    input.textContent = 'typed';
    openCellEditor(ctx, 0, 0, { html: '=SUM(', caret: 5 });
    expect(input.textContent).toBe('=SUM(');
    expect(textBeforeCaret()).toBe('=SUM(');
});
