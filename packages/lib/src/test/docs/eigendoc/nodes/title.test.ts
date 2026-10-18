import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions, PARAGRAPH_FORMAT_KEYS } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser, the editor mounts in the window.
installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const block = (type: string, text: string, attrs?: Record<string, unknown>): JSONContent => ({
    type,
    ...(attrs && { attrs }),
    content: [{ type: 'text', text }],
});

const parsed = (html: string): JSONContent[] => createDocument(html, schema).toJSON().content;

// A prose textblock parses with every paragraph format attribute, unset.
const UNFORMATTED = Object.fromEntries(PARAGRAPH_FORMAT_KEYS.map((key) => [key, null]));

describe.each(['title', 'subtitle'])('the %s node', (type) => {
    test('renders as a p marked by its data-type and parses back with its marks and alignment', () => {
        const node = {
            type,
            attrs: { textAlign: 'center' },
            content: [{ type: 'text', text: 'Plan', marks: [{ type: 'bold' }] }],
        };
        const html = generateHTML({ type: 'doc', content: [node] }, extensions);
        expect(html).toBe(`<p data-type="${type}" style="text-align: center;"><strong>Plan</strong></p>`);
        expect(parsed(html)).toEqual([{ ...node, attrs: { ...node.attrs, ...UNFORMATTED } }]);
    });

    // A web page's p.title is no Title.
    test(`a p with class ${type} stays a paragraph`, () => {
        expect(parsed(`<p class="${type}">Plan</p>`)).toEqual([
            block('paragraph', 'Plan', { textAlign: null, ...UNFORMATTED }),
        ]);
    });

    test('Enter at its end starts Normal text, as at the end of a heading', () => {
        const editor = new Editor({
            element: document.createElement('div'),
            extensions,
            content: { type: 'doc', content: [block(type, 'Plan')] },
        });
        editor.commands.setTextSelection(5);
        editor.commands.enter();
        // TrailingNode keeps a paragraph after the title too.
        const { $from } = editor.state.selection;
        expect([$from.index(0), $from.parent.type.name, editor.state.doc.firstChild?.type.name]).toEqual([
            1,
            'paragraph',
            type,
        ]);
        editor.destroy();
    });

    test('aligns as a paragraph does', () => {
        const editor = new Editor({
            element: document.createElement('div'),
            extensions,
            content: { type: 'doc', content: [block(type, 'Plan')] },
        });
        editor.commands.setTextSelection(2);
        editor.commands.setTextAlign('right');
        expect(editor.state.doc.firstChild?.attrs['textAlign']).toBe('right');
        editor.destroy();
    });
});
