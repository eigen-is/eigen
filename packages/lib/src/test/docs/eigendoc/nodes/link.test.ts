// The doc's link autolinks the word a space or Enter ends, as TipTap's does, read through a text walk where a footnote's
// note is one space, so a URL typed after a reference links itself alone.
import { afterAll, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import { JSDOM } from 'jsdom';
import { getDocExtensions } from '../../../../docs/eigendoc';

const { window } = new JSDOM();
const previous = { window: globalThis.window, document: globalThis.document };
Object.assign(globalThis, { window, document: window.document });
afterAll(() => {
    Object.assign(globalThis, previous);
});

function typed(content: JSONContent[], at: (editor: Editor) => number, keys: string[]): string[] {
    const editor = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
    editor.commands.setTextSelection(at(editor));
    for (const key of keys) {
        if (key === 'Enter') editor.commands.splitBlock();
        else for (const char of key) editor.view.dispatch(editor.state.tr.insertText(char));
    }
    const linked: string[] = [];
    editor.state.doc.descendants((node) => {
        const link = node.marks.find((mark) => mark.type.name === 'link');
        if (node.isText && link) linked.push(`${node.text} ${link.attrs.href}`);
    });
    editor.destroy();
    return linked;
}

const end = (editor: Editor) => (editor.state.doc.firstChild?.nodeSize ?? 0) - 1;
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const text = (t: string): JSONContent => ({ type: 'text', text: t });

test('a URL a space or Enter ends is a link, and a word is none', () => {
    expect(typed([paragraph(text('See'))], end, [' example.com '])).toEqual(['example.com http://example.com']);
    expect(typed([paragraph(text('See'))], end, [' https://eigen.is/docs', 'Enter'])).toEqual([
        'https://eigen.is/docs https://eigen.is/docs',
    ]);
    expect(typed([paragraph(text('See'))], end, [' plain words '])).toEqual([]);
});

test('past a footnote the URL links itself alone', () => {
    const note = { type: 'footnote', content: [paragraph(text('Hello world'))] };
    expect(typed([paragraph(text('Claim'), note)], end, [' then example.com '])).toEqual([
        'example.com http://example.com',
    ]);
    expect(typed([paragraph(text('Claim'), note)], end, ['example.com '])).toEqual(['example.com http://example.com']);
});
