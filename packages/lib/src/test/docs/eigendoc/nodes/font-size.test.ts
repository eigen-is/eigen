import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { DEFAULT_NORMAL_STYLE, getDocExtensions, selectionFontSizes } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
// Shift turns the key into > and <; prosemirror-keymap finds the binding through the key code.
const MOD_SHIFT_PERIOD: KeyboardEventInit = { key: '>', keyCode: 190, shiftKey: true, ...MOD };
const MOD_SHIFT_COMMA: KeyboardEventInit = { key: '<', keyCode: 188, shiftKey: true, ...MOD };

installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
});

const sized = (text: string, fontSize: unknown): JSONContent => ({
    type: 'text',
    text,
    marks: [{ type: 'textStyle', attrs: { fontSize } }],
});

const small = (text: string): JSONContent => ({ type: 'text', text, marks: [{ type: 'small' }] });

// The paragraph's text nodes as [text, fontSize, small] triples.
const sizesOf = (doc: JSONContent): [string | undefined, unknown, boolean][] =>
    (doc.content?.[0]?.content ?? []).map((node) => [
        node.text,
        node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['fontSize'] ?? null,
        node.marks?.some((mark) => mark.type === 'small') ?? false,
    ]);

const parsed = (html: string) => sizesOf(createDocument(`<p>${html}</p>`, schema).toJSON());

const mount = (content: JSONContent, editorExtensions = extensions): Editor =>
    new Editor({ element: document.createElement('div'), extensions: editorExtensions, content });

// A doc whose Normal is Word's 12 pt.
const NORMAL_12 = { ...DEFAULT_NORMAL_STYLE, size: 12 };

describe('font size HTML', () => {
    test('a size renders in pt', () => {
        expect(generateHTML(paragraph(sized('big', 14)), extensions)).toBe(
            '<p><span style="font-size: 14pt;">big</span></p>',
        );
    });

    test.each([
        ['font-size: 14pt', 14],
        ['font-size:10.5pt', 10.5],
        ['font-size: 16px', 12],
        ['font-size: 1000pt', 400],
        ['font-size: 1.2rem', null],
        ['font-size: 1.5em', null],
        ['font-size: 120%', null],
        ['font-size: large', null],
        ['font-size: smaller', null],
    ])('%s parses as %p', (style, fontSize) => {
        expect(parsed(`<span style="${style}">x</span>`)).toEqual([['x', fontSize, false]]);
    });

    // Yjs hands the stored attribute to renderHTML without parseHTML, so a forged one never reaches the page as is.
    test.each([
        ['1pt; position: fixed; inset: 0', '<p><span>x</span></p>'],
        [Number.NaN, '<p><span>x</span></p>'],
        [1e6, '<p><span style="font-size: 400pt;">x</span></p>'],
        [-3, '<p><span style="font-size: 1pt;">x</span></p>'],
    ])('a stored %p renders as %s', (fontSize, html) => {
        expect(generateHTML(paragraph(sized('x', fontSize)), extensions)).toBe(html);
    });

    test('Small still parses and renders, so a doc that holds it keeps its text', () => {
        expect(parsed('<small>fine</small>')).toEqual([['fine', null, true]]);
        expect(generateHTML(paragraph(small('fine')), extensions)).toBe('<p><small>fine</small></p>');
    });
});

describe('font size commands', () => {
    test('applyFontSize sets the size and unsets Small', () => {
        const editor = mount(paragraph(small('fine'), { type: 'text', text: ' print' }));
        editor.commands.setTextSelection({ from: 1, to: 11 });
        editor.commands.applyFontSize(14);
        expect(sizesOf(editor.getJSON())).toEqual([['fine print', 14, false]]);
        editor.destroy();
    });

    // Google's and Word's: a mixed selection keeps its mix, each run a point bigger.
    test('stepFontSize steps each run from the size it draws at, Small from 9 pt', () => {
        const editor = mount(paragraph({ type: 'text', text: 'body ' }, sized('big ', 14), small('fine')));
        editor.commands.setTextSelection({ from: 1, to: 14 });
        editor.commands.stepFontSize(1);
        expect(sizesOf(editor.getJSON())).toEqual([
            ['body ', 12, false],
            ['big ', 15, false],
            ['fine', 10, false],
        ]);
        editor.commands.stepFontSize(-1);
        expect(sizesOf(editor.getJSON())).toEqual([
            ['body ', 11, false],
            ['big ', 14, false],
            ['fine', 9, false],
        ]);
        editor.destroy();
    });

    test("unsized text steps from the doc's Normal, at a caret and in a range", () => {
        const editor = mount(
            paragraph({ type: 'text', text: 'body' }),
            getDocExtensions({ normalStyle: () => NORMAL_12 }),
        );
        editor.commands.setTextSelection({ from: 1, to: 5 });
        editor.commands.stepFontSize(1);
        expect(sizesOf(editor.getJSON())).toEqual([['body', 13, false]]);
        editor.commands.setTextSelection(5);
        editor.commands.stepFontSize(-1);
        editor.commands.insertContent('!');
        expect(sizesOf(editor.getJSON())).toEqual([
            ['body', 13, false],
            ['!', 12, false],
        ]);
        editor.destroy();
    });

    test('a step keeps the color and font the run had', () => {
        const editor = mount(
            paragraph({
                type: 'text',
                text: 'red',
                marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Source Serif 4' } }],
            }),
        );
        editor.commands.setTextSelection({ from: 1, to: 4 });
        editor.commands.stepFontSize(1);
        expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
            { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Source Serif 4', caps: null, fontSize: 12 } },
        ]);
        editor.destroy();
    });

    test('at a caret a step sets what the next typing draws at', () => {
        const editor = mount(paragraph(sized('big', 14)));
        editor.commands.setTextSelection(4);
        editor.commands.stepFontSize(1);
        editor.commands.insertContent('!');
        expect(sizesOf(editor.getJSON())).toEqual([
            ['big', 14, false],
            ['!', 15, false],
        ]);
        editor.destroy();
    });

    test("Mod-Shift-. and Mod-Shift-, step the size, Google's keys", () => {
        const editor = mount(paragraph({ type: 'text', text: 'word' }));
        editor.commands.setTextSelection({ from: 1, to: 5 });
        const press = (init: KeyboardEventInit) =>
            editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, new KeyboardEvent('keydown', init)));
        press(MOD_SHIFT_PERIOD);
        press(MOD_SHIFT_PERIOD);
        expect(sizesOf(editor.getJSON())).toEqual([['word', 13, false]]);
        press(MOD_SHIFT_COMMA);
        expect(sizesOf(editor.getJSON())).toEqual([['word', 12, false]]);
        editor.destroy();
    });

    test('Clear formatting removes the size', () => {
        const editor = mount(paragraph(sized('big', 14)));
        editor.commands.setTextSelection({ from: 1, to: 4 });
        editor.commands.unsetAllMarks();
        expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined();
        editor.destroy();
    });
});

describe('selectionFontSizes', () => {
    const sizesAt = (content: JSONContent, from: number, to = from, normal = DEFAULT_NORMAL_STYLE) => {
        const editor = mount(content);
        editor.commands.setTextSelection({ from, to });
        const sizes = [...selectionFontSizes(editor.state, editor.view, normal)];
        editor.destroy();
        return sizes;
    };

    test("unset text is the Normal's size, by default 11 pt, Small 9 pt, a size its own", () => {
        const doc = paragraph({ type: 'text', text: 'body ' }, small('fine '), sized('big', 14));
        expect(sizesAt(doc, 2)).toEqual([11]);
        expect(sizesAt(doc, 2, 2, NORMAL_12)).toEqual([12]);
        expect(sizesAt(doc, 8, 8, NORMAL_12)).toEqual([9]);
        expect(sizesAt(doc, 13, 13, NORMAL_12)).toEqual([14]);
    });

    test('a range holds every size it spans', () => {
        expect(sizesAt(paragraph({ type: 'text', text: 'body ' }, sized('big', 14)), 1, 9)).toEqual([11, 14]);
        expect(sizesAt(paragraph(sized('one ', 14), sized('two', 14)), 1, 8)).toEqual([14]);
    });
});
