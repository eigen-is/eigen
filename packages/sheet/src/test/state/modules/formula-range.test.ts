// Clicking a cell on another sheet while composing a formula writes that sheet's
// reference into the editor through innerHTML. The reference embeds the sheet's
// NAME, and updateSheetName screens only the six characters a reference may not
// contain (`: \ / ? * [ ]`) plus a 31-character limit — markup is a legal sheet
// name, and any collaborator or an uploaded xlsx can set one.
//
// The caret is then placed at the reference's length. Escaping makes the markup
// longer than what the browser renders, so the offset has to stay the RAW length
// — the regression commit ac3ff70df had to fix at the sibling formula-editor
// seam. rangeSetValue needs a real DOM, so this file installs happy-dom at module
// scope the way events/mouse-cell.test.ts does.

import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Context } from '../../../state/context';
import { resetFunctionHTMLIndex } from '../../../state/modules/formula-cache';
import { rangeSetValue } from '../../../state/modules/formula-range';
import { contextFactory } from '../factories/context';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;
g.DOMParser = win.DOMParser;

// The span index and the caret are module/window state: each case starts clean.
beforeEach(() => {
    resetFunctionHTMLIndex();
    win.getSelection()?.removeAllRanges();
});

const MARKUP_NAME = 'a<img src=q onerror=alert(1)>b';
// getRangetxt doubles the quotes in a name and wraps it, so B2 on that sheet reads:
const MARKUP_REF = `'${MARKUP_NAME}'!B2`;

function editorContext(name: string) {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].name = name;
    // The formula is being composed on another sheet, so the reference carries the
    // clicked sheet's name — getRangetxt only emits it when the two differ.
    ctx.formulaCache.rangetosheet = 'id_2';
    return ctx;
}

function editor(html = '') {
    const el = win.document.createElement('div') as unknown as HTMLDivElement;
    el.innerHTML = html;
    return el;
}

// The reference is a fresh token: a new coloured span is parsed and inserted.
describe('rangeSetValue — inserting a new reference', () => {
    test('writes markup in a sheet name as text, not as an element', () => {
        const $editor = editor();
        rangeSetValue(editorContext(MARKUP_NAME), $editor, { row: [1, 1], column: [1, 1] });

        expect($editor.querySelector('img')).toBeNull();
        expect($editor.innerHTML).toContain('&lt;img');
        expect($editor.querySelector('span.sheet-formula-functionrange-cell')?.textContent).toBe(MARKUP_REF);
    });

    test('the caret lands at the end of the rendered reference, not past it', () => {
        const $editor = editor();
        rangeSetValue(editorContext(MARKUP_NAME), $editor, { row: [1, 1], column: [1, 1] });

        // Past the rendered length setCaretPosition throws IndexSizeError, and its
        // catch then throws again on an undefined rangeResizeTo.
        expect(win.getSelection()?.anchorOffset).toBe(MARKUP_REF.length);
    });

    test('a plain sheet name is unchanged', () => {
        const $editor = editor();
        rangeSetValue(editorContext('MASTER DATA'), $editor, { row: [1, 1], column: [1, 1] });

        expect($editor.querySelector('span.sheet-formula-functionrange-cell')?.textContent).toBe("'MASTER DATA'!B2");
    });
});

// Dragging the range handles rewrites the span already carrying the reference.
describe('rangeSetValue — rewriting the span being dragged', () => {
    function dragContext(name: string) {
        const ctx = editorContext(name);
        ctx.formulaCache.rangestart = true;
        ctx.formulaCache.rangechangeindex = 0;
        return ctx;
    }

    test('writes markup in a sheet name as text, not as an element', () => {
        const $editor = editor(`<span class="sheet-formula-functionrange-cell" rangeindex="0">A1</span>`);
        rangeSetValue(dragContext(MARKUP_NAME), $editor, { row: [1, 1], column: [1, 1] });

        expect($editor.querySelector('img')).toBeNull();
        expect($editor.querySelector('span')?.textContent).toBe(MARKUP_REF);
    });

    test('the caret lands at the end of the rendered reference, not past it', () => {
        const $editor = editor(`<span class="sheet-formula-functionrange-cell" rangeindex="0">A1</span>`);
        rangeSetValue(dragContext(MARKUP_NAME), $editor, { row: [1, 1], column: [1, 1] });

        expect(win.getSelection()?.anchorOffset).toBe(MARKUP_REF.length);
    });
});
