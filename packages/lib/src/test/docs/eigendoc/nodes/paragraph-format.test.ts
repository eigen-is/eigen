import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import {
    DOCUMENT_PARAGRAPH_FORMAT,
    getDocExtensions,
    readParagraphFormat,
    selectionParagraphFormat,
} from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const p = (value: string, attrs?: Record<string, unknown>): JSONContent => ({
    type: 'paragraph',
    attrs,
    content: [text(value)],
});
const docOf = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const mount = (content: JSONContent): Editor =>
    new Editor({ element: document.createElement('div'), extensions, content });

// Each top-level block's stored format, unset keys left out.
const formatsOf = (editor: Editor) =>
    (editor.getJSON().content ?? []).map((block) =>
        Object.fromEntries(
            ['lineSpacing', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirstLine'].flatMap(
                (key) => (block.attrs?.[key] == null ? [] : [[key, block.attrs[key]]]),
            ),
        ),
    );

describe('paragraph format HTML', () => {
    test.each([
        [{ lineSpacing: 1 }, 'line-height: 1.21', 'data-line-spacing="1"'],
        [{ lineSpacing: 1.15 }, 'line-height: 1.3915', 'data-line-spacing="1.15"'],
        [{ lineSpacing: 1.5 }, 'line-height: 1.815', 'data-line-spacing="1.5"'],
        [{ lineSpacing: 2 }, 'line-height: 2.42', 'data-line-spacing="2"'],
        [{ spaceBefore: 12 }, 'margin-top: 12pt', 'data-space-before="12"'],
        [{ spaceAfter: 0 }, 'margin-bottom: 0pt', 'data-space-after="0"'],
        [{ indentLeft: 36 }, 'margin-left: 36pt', 'data-indent-left="36"'],
        [{ indentRight: 18 }, 'margin-right: 18pt', 'data-indent-right="18"'],
        [{ indentFirstLine: -18 }, 'text-indent: -18pt', 'data-indent-first-line="-18"'],
    ])('%p renders as %s', (attrs, css, data) => {
        const html = generateHTML(docOf(p('x', attrs)), extensions);
        expect(html).toContain(`style="${css};"`);
        expect(html).toContain(data);
    });

    test('a heading, the title and the subtitle take it too, a code block not', () => {
        const attrs = { lineSpacing: 2 };
        const html = generateHTML(
            docOf(
                { type: 'heading', attrs: { level: 1, ...attrs }, content: [text('h')] },
                { type: 'title', attrs, content: [text('t')] },
                { type: 'subtitle', attrs, content: [text('s')] },
            ),
            extensions,
        );
        expect(html.match(/line-height: 2\.42/g)?.length).toBe(3);
        expect(schema.nodes['codeBlock']).toBeUndefined();
        expect(schema.nodes['blockquote']?.spec.attrs?.['lineSpacing']).toBeUndefined();
    });

    test('an unset paragraph renders nothing of its own', () => {
        expect(generateHTML(docOf(p('x')), extensions)).toBe('<p>x</p>');
    });

    // Yjs hands the stored attribute to renderHTML without parseHTML, so a forged one never reaches the page as is.
    test.each([
        [{ lineSpacing: '1; position: fixed; inset: 0' }, '<p>x</p>'],
        [{ spaceBefore: Number.NaN }, '<p>x</p>'],
        [{ indentLeft: Number.POSITIVE_INFINITY }, '<p>x</p>'],
        [{ lineSpacing: 1e6 }, '<p style="line-height: 6.05;" data-line-spacing="5">x</p>'],
        [{ lineSpacing: 0.1 }, '<p style="line-height: 0.605;" data-line-spacing="0.5">x</p>'],
        [{ spaceAfter: -3 }, '<p style="margin-bottom: 0pt;" data-space-after="0">x</p>'],
        [{ spaceBefore: 9999 }, '<p style="margin-top: 400pt;" data-space-before="400">x</p>'],
        [{ indentLeft: 1e9 }, '<p style="margin-left: 1584pt;" data-indent-left="1584">x</p>'],
        [{ indentFirstLine: -1e9 }, '<p style="text-indent: -1584pt;" data-indent-first-line="-1584">x</p>'],
    ])('a stored %p renders as %s', (attrs, html) => {
        expect(generateHTML(docOf(p('x', attrs)), extensions)).toBe(html);
    });

    test('the readers round to the unit Word stores: a hundredth of a line, a twentieth of a point', () => {
        expect(readParagraphFormat({ lineSpacing: 1.154, spaceBefore: 12.33, indentFirstLine: -0.01 })).toEqual({
            lineSpacing: 1.15,
            spaceBefore: 12.35,
            indentFirstLine: -0,
        });
    });
});

describe('paragraph format paste', () => {
    const parsed = (html: string) => formatsOf(mount(createDocument(html, schema).toJSON()));

    test("Eigen's own HTML parses back", () => {
        const html = generateHTML(
            docOf(p('x', { lineSpacing: 1.15, spaceBefore: 6, spaceAfter: 0, indentLeft: 36, indentFirstLine: -18 })),
            extensions,
        );
        expect(parsed(html)).toEqual([
            { lineSpacing: 1.15, spaceBefore: 6, spaceAfter: 0, indentLeft: 36, indentFirstLine: -18 },
        ]);
    });

    // Google Docs writes its body's look on every paragraph; a pasted paragraph takes the doc's.
    test("another app's paragraph CSS gives no format", () => {
        expect(
            parsed(
                '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;margin-left:36pt;text-indent:-18pt">x</p>',
            ),
        ).toEqual([{}]);
    });

    test('a forged data attribute is bounded, a blank or a word none', () => {
        expect(parsed('<p data-line-spacing="99" data-space-before="" data-indent-left="wide">x</p>')).toEqual([
            { lineSpacing: 5 },
        ]);
    });
});

describe('paragraph format commands', () => {
    test('setParagraphFormat sets every prose textblock the selection spans, and only the keys given', () => {
        const editor = mount(
            docOf(
                p('one', { spaceAfter: 4 }),
                { type: 'heading', attrs: { level: 2 }, content: [text('two')] },
                p('three'),
            ),
        );
        editor.commands.setTextSelection({ from: 2, to: 8 });
        editor.commands.setParagraphFormat({ lineSpacing: 1.5 });
        expect(formatsOf(editor)).toEqual([{ lineSpacing: 1.5, spaceAfter: 4 }, { lineSpacing: 1.5 }, {}]);
        expect(editor.getJSON().content?.[1]?.attrs?.['level']).toBe(2);
        editor.commands.setParagraphFormat({ lineSpacing: null, spaceBefore: 1e6 });
        expect(formatsOf(editor)).toEqual([{ spaceAfter: 4, spaceBefore: 400 }, { spaceBefore: 400 }, {}]);
        editor.destroy();
    });

    test('Increase and Decrease indent step to the next multiple of 1.27 cm, an unset one from 0', () => {
        const editor = mount(docOf(p('a'), p('b', { indentLeft: 40 })));
        editor.commands.setTextSelection({ from: 2, to: 5 });
        editor.commands.stepIndent(1);
        expect(formatsOf(editor)).toEqual([{ indentLeft: 36 }, { indentLeft: 72 }]);
        editor.commands.stepIndent(-1);
        editor.commands.stepIndent(-1);
        expect(formatsOf(editor)).toEqual([{}, {}]);
        editor.commands.stepIndent(-1);
        expect(formatsOf(editor)).toEqual([{}, {}]);
        editor.destroy();
    });

    test('a hanging indent keeps its first line as Increase indent moves it', () => {
        const editor = mount(docOf(p('a', { indentLeft: 36, indentFirstLine: -36 })));
        editor.commands.setTextSelection(2);
        editor.commands.stepIndent(1);
        expect(formatsOf(editor)).toEqual([{ indentLeft: 72, indentFirstLine: -36 }]);
        editor.destroy();
    });

    const list = (type: string, item: string) => ({
        type,
        content: [
            { type: item, ...(item === 'taskItem' && { attrs: { checked: false } }), content: [p('one')] },
            { type: item, ...(item === 'taskItem' && { attrs: { checked: false } }), content: [p('two')] },
        ],
    });

    test.each([
        ['bulletList', 'listItem'],
        ['taskList', 'taskItem'],
    ])('in a %s they sink and lift the item, as Tab does, and set no indent', (type, item) => {
        const editor = mount(docOf(list(type, item)));
        editor.commands.setTextSelection(11);
        expect(editor.state.selection.$from.parent.textContent).toBe('two');
        editor.commands.stepIndent(1);
        const sunk = editor.state.doc.child(0);
        expect(sunk.childCount).toBe(1);
        expect(sunk.child(0).child(1).type.name).toBe(type);
        editor.commands.stepIndent(-1);
        expect(editor.state.doc.child(0).toJSON()).toEqual(schema.nodeFromJSON(list(type, item)).toJSON());
        editor.destroy();
    });

    test('⌘] and ⌘[ step the indent, and are swallowed where nothing steps', () => {
        const editor = mount(docOf(p('a')));
        editor.commands.setTextSelection(2);
        const press = (key: string, keyCode: number) =>
            editor.view.someProp('handleKeyDown', (handle) =>
                handle(editor.view, new KeyboardEvent('keydown', { key, keyCode, ...MOD })),
            );
        expect(press(']', 221)).toBe(true);
        expect(formatsOf(editor)).toEqual([{ indentLeft: 36 }]);
        expect(press('[', 219)).toBe(true);
        expect(press('[', 219)).toBe(true);
        expect(formatsOf(editor)).toEqual([{}]);
        editor.destroy();
    });
});

describe('selectionParagraphFormat', () => {
    const formatAt = (content: JSONContent, from: number, to = from) => {
        const editor = mount(content);
        editor.commands.setTextSelection({ from, to });
        const format = selectionParagraphFormat(editor.state, editor.view);
        editor.destroy();
        return format;
    };

    test("an unset paragraph draws Eigen's look and stores no line spacing", () => {
        expect(formatAt(docOf(p('a')), 1)).toEqual({ lineSpacing: undefined, drawn: DOCUMENT_PARAGRAPH_FORMAT });
    });

    test('a shared line spacing reads as it, a mix or an unset one as none; the first block is what draws', () => {
        const doc = docOf(p('a', { lineSpacing: 1.15, spaceBefore: 6 }), p('b', { lineSpacing: 1.15 }), p('c'));
        expect(formatAt(doc, 1, 4)).toEqual({
            lineSpacing: 1.15,
            drawn: { ...DOCUMENT_PARAGRAPH_FORMAT, lineSpacing: 1.15, spaceBefore: 6 },
        });
        expect(formatAt(doc, 1, 7).lineSpacing).toBeUndefined();
    });
});
