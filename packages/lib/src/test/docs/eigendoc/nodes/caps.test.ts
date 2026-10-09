import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// Shift capitalises the key; prosemirror-keymap finds the binding through the key code.
const MOD_SHIFT_A: KeyboardEventInit = {
    key: 'A',
    keyCode: 65,
    shiftKey: true,
    ...(/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
};

installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
});

const capsText = (text: string, caps: string | null, fontFamily: string | null = null): JSONContent => ({
    type: 'text',
    text,
    marks: [{ type: 'textStyle', attrs: { color: null, fontFamily, caps } }],
});

// The marks of the paragraph's text nodes, as [text, caps] pairs.
const capsOf = (doc: JSONContent): [string | undefined, unknown][] =>
    (doc.content?.[0]?.content ?? []).map((node) => [
        node.text,
        node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['caps'] ?? null,
    ]);

const mount = (content: JSONContent): Editor =>
    new Editor({ element: document.createElement('div'), extensions, content });

describe('caps HTML', () => {
    test('all caps is text-transform and small caps font-variant-caps, the letters as typed', () => {
        expect(generateHTML(paragraph(capsText('Title', 'all'), capsText(' Name', 'small')), extensions)).toBe(
            '<p><span style="text-transform: uppercase;">Title</span><span style="font-variant-caps: small-caps;"> Name</span></p>',
        );
    });

    test('caps share the textStyle span with a font', () => {
        expect(generateHTML(paragraph(capsText('Serif', 'small', 'Source Serif 4')), extensions)).toContain(
            'font-variant-caps: small-caps',
        );
    });

    // Word writes text-transform:uppercase and font-variant:small-caps; the longhand is what the editor writes back.
    test.each([
        ['<span style="text-transform:uppercase">x</span>', 'all'],
        ['<span style="font-variant:small-caps">x</span>', 'small'],
        ['<span style="font-variant-caps: small-caps">x</span>', 'small'],
        // Both: capitals leave no lowercase letter for small caps to draw.
        ['<span style="text-transform: uppercase; font-variant-caps: small-caps">x</span>', 'all'],
        // Google Docs writes the defaults on every span.
        ['<span style="font-variant:normal;text-transform:none">x</span>', null],
        ['<span style="text-transform: lowercase">x</span>', null],
    ])('%s parses as %s', (html, caps) => {
        expect(capsOf(createDocument(`<p>${html}</p>`, schema).toJSON())).toEqual([['x', caps]]);
    });

    test('caps survive the HTML round-trip', () => {
        const doc = paragraph(capsText('Title', 'all'), capsText(' Name', 'small'));
        expect(capsOf(createDocument(generateHTML(doc, extensions), schema).toJSON())).toEqual([
            ['Title', 'all'],
            [' Name', 'small'],
        ]);
    });
});

describe('caps commands', () => {
    test('toggleCaps sets, switches and unsets, and an empty textStyle goes with it', () => {
        const editor = mount(paragraph({ type: 'text', text: 'word' }));
        editor.commands.setTextSelection({ from: 1, to: 5 });
        editor.commands.toggleCaps('all');
        expect(capsOf(editor.getJSON())).toEqual([['word', 'all']]);
        expect(editor.isActive('textStyle', { caps: 'all' })).toBe(true);
        editor.commands.toggleCaps('small');
        expect(capsOf(editor.getJSON())).toEqual([['word', 'small']]);
        editor.commands.toggleCaps('small');
        expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined();
        editor.destroy();
    });

    test('unsetting caps keeps the font', () => {
        const editor = mount(paragraph(capsText('word', 'all', 'Source Serif 4')));
        editor.commands.setTextSelection({ from: 1, to: 5 });
        editor.commands.unsetCaps();
        expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
            { type: 'textStyle', attrs: { color: null, fontFamily: 'Source Serif 4', caps: null } },
        ]);
        editor.destroy();
    });

    test('Clear formatting removes caps', () => {
        const editor = mount(paragraph(capsText('word', 'small')));
        editor.commands.setTextSelection({ from: 1, to: 5 });
        editor.commands.unsetAllMarks();
        expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined();
        editor.destroy();
    });

    // Word's shortcut; its small caps one, Mod-Shift-K, is the command palette's.
    test('Mod-Shift-A toggles all caps', () => {
        const editor = mount(paragraph({ type: 'text', text: 'word' }));
        editor.commands.setTextSelection({ from: 1, to: 5 });
        const press = () =>
            editor.view.someProp('handleKeyDown', (handle) =>
                handle(editor.view, new KeyboardEvent('keydown', MOD_SHIFT_A)),
            );
        press();
        expect(capsOf(editor.getJSON())).toEqual([['word', 'all']]);
        press();
        expect(capsOf(editor.getJSON())).toEqual([['word', null]]);
        editor.destroy();
    });
});
