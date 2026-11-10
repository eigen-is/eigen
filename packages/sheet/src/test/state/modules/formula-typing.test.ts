// Each keystroke in a formula rebuilds the editor's colored spans, then puts the caret back. Typing key by key
// must end with the text as typed, wherever the spans split: at a newline, a string literal or a reference.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Context } from '../../../state/context';
import { handleFormulaInput } from '../../../state/modules/formula-editor';
import { workbookContextFactory } from '../factories/context';

installHappyDom();

let input: HTMLDivElement;
let ctx: Context;
beforeEach(() => {
    input = document.createElement('div');
    input.id = 'sheet-rich-text-editor';
    input.contentEditable = 'true';
    // The editor is pre-wrap, so a browser reads a typed newline back; happy-dom's innerText drops it.
    Object.defineProperty(input, 'innerText', { get: () => input.textContent });
    document.body.append(input);
    input.focus();
    document.getSelection()?.collapse(input, 0);
    ctx = workbookContextFactory();
});
afterEach(() => input.remove());

// What the browser does with a typed key: it adds the text to the text node at the caret, the caret after it.
function typeAtCaret(text: string) {
    const selection = document.getSelection();
    const { anchorNode, anchorOffset } = selection ?? {};
    if (!(anchorNode instanceof Text) || anchorOffset == null) return pasteAtCaret(text);
    anchorNode.insertData(anchorOffset, text);
    selection?.collapse(anchorNode, anchorOffset + text.length);
}

// What insertHTML does, as Alt+Enter uses it: the text is a node of its own at the caret.
function pasteAtCaret(text: string) {
    const caret = document.getSelection()?.getRangeAt(0);
    if (!caret) throw new Error('no caret');
    const node = document.createTextNode(text);
    caret.insertNode(node);
    document.getSelection()?.collapse(node, text.length);
}

// A character key, then the editor's onChange. Alt+Enter types a newline and does not reach onChange.
function type(keys: string) {
    for (const key of keys) {
        const preText = input.innerText;
        if (key === '\n') {
            pasteAtCaret(key);
            continue;
        }
        typeAtCaret(key);
        handleFormulaInput(ctx, null, input, key.toUpperCase().charCodeAt(0), preText);
    }
}

describe('typing a formula key by key', () => {
    for (const formula of ['=SUM(A2:\nA4)', '=VLOOKUP("k3",A1:B4,2)', '="ab"&"c"', '=1+\n2']) {
        test(JSON.stringify(formula), () => {
            type(formula);
            expect(input.textContent).toBe(formula);
        });
    }

    test('inside a closed call, as after an arrow key', () => {
        type('=SUM()');
        const rpar = input.querySelector('.sheet-formula-text-rpar')?.firstChild;
        if (!rpar) throw new Error('no closing parenthesis');
        document.getSelection()?.collapse(rpar, 0);
        type('A1,"x"');
        expect(input.textContent).toBe('=SUM(A1,"x")');
    });
});
