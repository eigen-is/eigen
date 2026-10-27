import { afterAll, describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { createDocument, Editor, generateHTML, getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';
import {
    BAND_EXCLUDED_NODES,
    FOOTNOTE_PARAGRAPH,
    flattenNestedStories,
    footnoteNumbers,
    footnotesInOrder,
    getDocExtensions,
    insertFootnote,
} from '../../../../docs/eigendoc';

// jsdom's, a spec HTML parser: a pasted note must survive the one a browser runs, where a <p> in a <p> closes it.
const { window } = new JSDOM();
const previous = { window: globalThis.window, document: globalThis.document, DOMParser: globalThis.DOMParser };
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser });
afterAll(() => {
    Object.assign(globalThis, previous);
});

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'text',
    text: value,
    ...(marks && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: 'paragraph',
    ...(content.length > 0 && { content }),
});
const footnote = (...paragraphs: JSONContent[]): JSONContent => ({ type: 'footnote', content: paragraphs });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const BOLD = [{ type: 'bold' }];
const LINK = [{ type: 'link', attrs: { href: 'https://example.org', target: '_blank', rel: 'noopener noreferrer' } }];

const CLAIM = doc(
    paragraph(
        text('A claim'),
        footnote(
            paragraph(text('See '), text('Smith', BOLD), text(', p. 4.')),
            paragraph(text('A second paragraph with '), text('a link', LINK)),
        ),
        text(' and more.'),
    ),
);

const parse = (html: string): JSONContent => createDocument(html, schema).toJSON();
// The JSON as the schema stores it, every attribute's default spelled out.
const stored = (content: JSONContent) => Node.fromJSON(schema, content).toJSON();

describe('the footnote node', () => {
    test('is an inline atom holding its paragraphs, in the inline group, isolating and selectable', () => {
        const type = schema.nodes['footnote'];
        expect(type?.isInline).toBe(true);
        expect(type?.isAtom).toBe(true);
        expect(type?.spec.group).toBe('inline');
        expect(type?.spec.content).toBe('paragraph+');
        expect(type?.spec.isolating).toBe(true);
        expect(type?.spec.selectable).toBe(true);
        // Numbering derives from document order: the node stores its story id alone.
        expect(Object.keys(type?.spec.attrs ?? {})).toEqual(['id']);
    });

    test('sits wherever inline content does: a heading, a list item, a table cell', () => {
        const note = footnote(paragraph(text('n')));
        const node = Node.fromJSON(
            schema,
            doc(
                { type: 'heading', attrs: { level: 1 }, content: [note] },
                { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(note)] }] },
                {
                    type: 'table',
                    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(note)] }] }],
                },
            ),
        );
        expect(() => node.check()).not.toThrow();
    });

    test("a band's schema has none", () => {
        expect(BAND_EXCLUDED_NODES.has('footnote')).toBe(true);
        expect(getSchema(getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] })).nodes['footnote']).toBeUndefined();
    });
});

describe('footnote HTML', () => {
    test("renders its paragraphs as spans in the body's paragraph", () => {
        expect(generateHTML(CLAIM, extensions)).toBe(
            '<p>A claim<span class="footnote" data-type="footnote">' +
                `<span data-type="${FOOTNOTE_PARAGRAPH}">See <strong>Smith</strong>, p. 4.</span>` +
                `<span data-type="${FOOTNOTE_PARAGRAPH}">A second paragraph with <a target="_blank" rel="noopener noreferrer" href="https://example.org">a link</a></span>` +
                '</span> and more.</p>',
        );
    });

    test('parses back to the same note, both paragraphs and their marks', () => {
        expect(parse(generateHTML(CLAIM, extensions))).toEqual(stored(CLAIM));
    });

    // A copied paragraph holding a note pastes as one paragraph, its note inside.
    test('a pasted paragraph with a note stays one paragraph', () => {
        const pasted = parse(generateHTML(CLAIM, extensions));
        expect(pasted.content?.map((block) => block.type)).toEqual(['paragraph']);
        expect(pasted.content?.[0]?.content?.map((inline) => inline.type)).toEqual(['text', 'footnote', 'text']);
    });

    test('keeps its story id, and reads a forged one as none', () => {
        const withId = doc(paragraph(text('a'), { ...footnote(paragraph(text('n'))), attrs: { id: 'note-1' } }));
        const html = generateHTML(withId, extensions);
        expect(html).toContain('<span class="footnote" data-type="footnote" data-story-id="note-1">');
        expect(parse(html)).toEqual(stored(withId));
        const forged = parse(
            '<p>a<span class="footnote" data-type="footnote" data-story-id="no spaces"><span>n</span></span></p>',
        );
        expect(forged.content?.[0]?.content?.[1]?.attrs?.['id']).toBeNull();
    });

    test('an empty note keeps one empty paragraph', () => {
        const empty = doc(paragraph(text('a'), footnote(paragraph())));
        expect(parse(generateHTML(empty, extensions))).toEqual(stored(empty));
        expect(parse('<p>a<span class="footnote" data-type="footnote"></span></p>')).toEqual(stored(empty));
    });

    // A web page's own footnote markup is its text, not a note.
    test("parses Eigen's markup only", () => {
        expect(parse('<p>a<span class="footnote">b</span></p>')).toEqual(stored(doc(paragraph(text('ab')))));
    });

    test('a note pasted inside a note keeps its text, flattened into the outer note', () => {
        const html =
            '<p>a<span class="footnote" data-type="footnote">' +
            `<span data-type="${FOOTNOTE_PARAGRAPH}">outer<span class="footnote" data-type="footnote">` +
            `<span data-type="${FOOTNOTE_PARAGRAPH}">inner</span><span data-type="${FOOTNOTE_PARAGRAPH}">two</span>` +
            '</span></span></span></p>';
        expect(parse(html)).toEqual(stored(doc(paragraph(text('a'), footnote(paragraph(text('outer inner two')))))));
    });
});

describe('flattenNestedStories over notes', () => {
    test('puts a nested note’s inline content in its place, each paragraph after a space, marks kept', () => {
        const forged = doc(
            paragraph(
                text('a'),
                footnote(
                    paragraph(
                        text('outer'),
                        footnote(
                            paragraph(text('in', BOLD)),
                            paragraph(text('two'), footnote(paragraph(text('three')))),
                        ),
                        text('.'),
                    ),
                ),
            ),
        );
        expect(stored(flattenNestedStories(forged))).toEqual(
            stored(
                doc(paragraph(text('a'), footnote(paragraph(text('outer '), text('in', BOLD), text(' two three.'))))),
            ),
        );
    });

    test('leaves a doc without nested notes as it is', () => {
        expect(flattenNestedStories(CLAIM)).toEqual(CLAIM);
    });
});

describe('footnote numbering', () => {
    const notes = doc(
        paragraph(text('a'), footnote(paragraph(text('one'), footnote(paragraph(text('nested')))))),
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [{ type: 'tableCell', content: [paragraph(footnote(paragraph(text('two'))))] }],
                },
            ],
        },
        {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [paragraph(footnote(paragraph(text('three'))))] }],
        },
    );

    test('numbers the notes 1, 2, 3 in document order, a nested note none', () => {
        const node = Node.fromJSON(schema, notes);
        const numbers = footnoteNumbers(node);
        expect([...numbers.values()]).toEqual([1, 2, 3]);
        expect([...numbers.keys()].map((pos) => node.nodeAt(pos)?.firstChild?.firstChild?.text)).toEqual([
            'one',
            'two',
            'three',
        ]);
    });

    test('the server reads the same order from the JSON', () => {
        expect(footnotesInOrder(notes).map((note) => note.content?.[0]?.content?.[0]?.text)).toEqual([
            'one',
            'two',
            'three',
        ]);
    });
});

describe('insertFootnote', () => {
    const stateOf = (content: JSONContent, selection: (node: Node) => TextSelection | NodeSelection) => {
        const node = Node.fromJSON(schema, content);
        return EditorState.create({ doc: node, selection: selection(node) });
    };

    test('inserts the reference at the caret with one empty paragraph, the caret after it', () => {
        const state = stateOf(doc(paragraph(text('ab'))), (node) => TextSelection.create(node, 2));
        const { tr } = state;
        const pos = insertFootnote(tr);
        expect(pos).toBe(2);
        const id = tr.doc.nodeAt(2)?.attrs['id'];
        expect(id).toMatch(/^[\w-]{10}$/);
        expect(tr.doc.toJSON()).toEqual(
            stored(doc(paragraph(text('a'), { ...footnote(paragraph()), attrs: { id } }, text('b')))),
        );
        expect(tr.doc.nodeAt(2)?.type.name).toBe('footnote');
        expect(tr.selection.from).toBe(2 + (tr.doc.nodeAt(2)?.nodeSize ?? 0));
    });

    // As Word and Google Docs: a selected text stays, the reference follows it.
    test('after a selected text, which stays', () => {
        const state = stateOf(doc(paragraph(text('abc'))), (node) => TextSelection.create(node, 1, 3));
        const { tr } = state;
        expect(insertFootnote(tr)).toBe(3);
        const id = tr.doc.nodeAt(3)?.attrs['id'];
        expect(tr.doc.toJSON()).toEqual(
            stored(doc(paragraph(text('ab'), { ...footnote(paragraph()), attrs: { id } }, text('c')))),
        );
    });

    test('after a selected image', () => {
        const state = stateOf(doc(paragraph(text('a'), { type: 'figure', attrs: { mediaName: 'a.png' } })), (node) =>
            NodeSelection.create(node, 2),
        );
        const { tr } = state;
        expect(insertFootnote(tr)).toBe(3);
        expect(tr.doc.lastChild?.lastChild?.type.name).toBe('footnote');
    });

    test('refuses inside a note, in a code block, and where the schema has none', () => {
        const inNote = stateOf(doc(paragraph(text('a'), footnote(paragraph(text('note'))))), (node) =>
            TextSelection.create(node, 5),
        );
        expect(insertFootnote(inNote.tr)).toBeNull();

        const withCode = getSchema(getDocExtensions({ lowlight: { highlight: () => ({ children: [] }) } }));
        const code = Node.fromJSON(withCode, doc({ type: 'codeBlock', content: [text('x')] }));
        expect(
            insertFootnote(EditorState.create({ doc: code, selection: TextSelection.create(code, 1) }).tr),
        ).toBeNull();

        const band = getSchema(getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] }));
        const header = Node.fromJSON(band, doc(paragraph(text('a'))));
        expect(
            insertFootnote(EditorState.create({ doc: header, selection: TextSelection.create(header, 1) }).tr),
        ).toBeNull();
    });
});

describe('footnote text', () => {
    // A plain-text copy reads the sentence: the number is the doc's order, which a text serializer never sees, and the
    // note's text would run into the sentence.
    test('a plain-text copy leaves the note out', () => {
        expect(getText(Node.fromJSON(schema, CLAIM), { textSerializers: getTextSerializersFromSchema(schema) })).toBe(
            'A claim and more.',
        );
    });

    // Tiptap's input rules read the text before the caret, the note's included, so a rule's match must never reach
    // into the note.
    test.each([
        ['(c', ')'],
        ['#', ' '],
        ['-', '-'],
    ])('a note ending in "%s" and "%s" typed after it stays a paragraph with its note', (noteText, typed) => {
        const content = doc(paragraph(footnote(paragraph(text(noteText)))));
        const editor = new Editor({ extensions, content });
        const after = editor.state.doc.firstChild?.firstChild?.nodeSize ?? 0;
        editor.commands.setTextSelection(1 + after);
        const { view } = editor;
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(typed, from, to);
        if (!view.someProp('handleTextInput', (handle) => handle(view, from, to, typed, insert)))
            view.dispatch(insert());
        const result = editor.state.doc.toJSON();
        editor.destroy();
        expect(result).toEqual(stored(doc(paragraph(footnote(paragraph(text(noteText))), text(typed)))));
    });
});
