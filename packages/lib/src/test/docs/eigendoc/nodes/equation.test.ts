import { afterAll, describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { MATH_LIMITS, MATHML_NAMESPACE, type MathRow, readLatex, writeMathml } from '@workspace/math';
import { Window } from 'happy-dom';
import { JSDOM } from 'jsdom';
import { getDocExtensions, readEquation } from '../../../../docs/eigendoc';

// jsdom's, since happy-dom's HTML parser puts a <math> in the XHTML namespace, where a browser's puts it in MathML's.
const { window } = new JSDOM();
const previous = { window: globalThis.window, document: globalThis.document, DOMParser: globalThis.DOMParser };
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser });
afterAll(() => {
    Object.assign(globalThis, previous);
});

const schema = getSchema(getDocExtensions());
const MATH = `<math xmlns="${MATHML_NAMESPACE}">`;
const x: MathRow = [{ kind: 'identifier', text: 'x' }];
const xSquared: MathRow = [{ kind: 'scripts', base: x, sup: [{ kind: 'number', text: '2' }] }];

const equationDoc = (attrs: Record<string, unknown>) =>
    schema.nodeFromJSON({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'a ' },
                    { type: 'equation', attrs },
                ],
            },
        ],
    });

const equationsIn = (doc: ProseMirrorNode) => {
    const equations: Record<string, unknown>[] = [];
    doc.descendants((node) => {
        if (node.type.name === 'equation') equations.push(node.attrs);
    });
    return equations;
};

const parsed = (html: string) => equationsIn(createDocument(html, schema));

// Nested past MATH_LIMITS.depth, so every reader refuses the tree.
const tooDeep = `${'<mrow>'.repeat(MATH_LIMITS.depth + 1)}<mi>x</mi>${'</mrow>'.repeat(MATH_LIMITS.depth + 1)}`;

describe('equation schema', () => {
    test('an inline atom whose attrs default to an empty inline equation', () => {
        const type = schema.nodes['equation'];
        expect(type.isInline).toBe(true);
        expect(type.isAtom).toBe(true);
        expect(type.spec.group).toBe('inline');
        expect(type.create().attrs).toEqual({ mathml: '', display: false, commentCardId: null });
    });

    test('a stored equation comes back from JSON as it went in', () => {
        const attrs = { mathml: writeMathml(x, 'x'), display: true, commentCardId: 'card-1' };
        const doc = equationDoc(attrs);
        expect(schema.nodeFromJSON(doc.toJSON()).eq(doc)).toBe(true);
        expect(equationsIn(doc)).toEqual([attrs]);
    });
});

describe('equation renderHTML', () => {
    test('writes the MathML the package reads, display and comment card on the <math>', () => {
        const html = generateHTML(
            equationDoc({ mathml: writeMathml(x, 'x'), display: true, commentCardId: 'card-1' }).toJSON(),
            getDocExtensions(),
        );
        expect(html).toBe(
            `<p>a <span><math xmlns="${MATHML_NAMESPACE}" display="block" data-comment-id="card-1"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math></span></p>`,
        );
    });

    test('never mounts the stored string: what the writer does not write is gone', () => {
        const forged = `${MATH}<mi onclick="alert(1)">x</mi><script>alert(2)</script><foreignObject><img src="a.png"/></foreignObject></math>`;
        const html = generateHTML(equationDoc({ mathml: forged }).toJSON(), getDocExtensions());
        expect(html).toBe(`<p>a <span>${MATH}<mi>x</mi></math></span></p>`);
    });

    test('an empty equation renders an empty <math> for the node view to box', () => {
        expect(generateHTML(equationDoc({}).toJSON(), getDocExtensions())).toBe(`<p>a <span>${MATH}</math></span></p>`);
    });
});

describe('equation parseHTML', () => {
    test("Eigen's own copy parses back to the same attrs", () => {
        const attrs = { mathml: writeMathml(xSquared, 'x^2'), display: true, commentCardId: 'card-1' };
        expect(parsed(generateHTML(equationDoc(attrs).toJSON(), getDocExtensions()))).toEqual([attrs]);
    });

    test("a web page's MathML with a TeX annotation keeps the annotation, written in Eigen's dialect", () => {
        const katex =
            '<p>a <math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></p>';
        expect(parsed(katex)).toEqual([{ mathml: writeMathml(xSquared, 'x^2'), display: false, commentCardId: null }]);
    });

    test('plain MathML parses without an annotation, display="block" lifted into display', () => {
        expect(parsed('<p><math display="block"><mi>x</mi><mo>+</mo><mn>1</mn></math></p>')).toEqual([
            {
                mathml: writeMathml([
                    { kind: 'identifier', text: 'x' },
                    { kind: 'operator', text: '+' },
                    { kind: 'number', text: '1' },
                ]),
                display: true,
                commentCardId: null,
            },
        ]);
    });

    test('a foreign mathml attribute never reaches the doc', () => {
        expect(parsed('<p><math mathml="<mi>y</mi>"><mi>x</mi></math></p>')).toEqual([
            { mathml: writeMathml(x), display: false, commentCardId: null },
        ]);
    });

    test('a <math> the package refuses parses as nothing, its text included', () => {
        const doc = createDocument(`<p>a <math>${tooDeep}</math> b</p>`, schema);
        expect(equationsIn(doc)).toEqual([]);
        expect(doc.textContent).toBe('a b');
    });
});

describe('readEquation', () => {
    const empty = { row: [], latex: undefined, mathml: `${MATH}</math>`, text: '', display: false };

    test('reads a stored equation to its tree, LaTeX, written MathML, text and display', () => {
        const mathml = writeMathml(xSquared, 'x^2');
        expect(readEquation({ mathml, display: true })).toEqual({
            row: xSquared,
            latex: 'x^2',
            mathml,
            text: 'x^2',
            display: true,
        });
    });

    test('a value of the wrong type reads as an empty inline equation', () => {
        expect(readEquation({ mathml: 7, display: 'true' })).toEqual(empty);
    });

    test('an empty or malformed string reads as an empty equation', () => {
        for (const mathml of ['', `${MATH}<mi>x</mi>`, 'x^2']) {
            expect(readEquation({ mathml })).toEqual(empty);
        }
    });

    // Bun's parser refuses a DOCTYPE; the browser's would expand its entities, so the two would disagree.
    test('a prolog, DOCTYPE or entity declaration reads as an empty equation, as on the server', () => {
        for (const mathml of [
            `<!DOCTYPE math [<!ENTITY e "x">]>${MATH}<mi>&e;</mi></math>`,
            `<?xml version="1.0"?>${MATH}<mi>x</mi></math>`,
            ` ${MATH}<mi>x</mi></math>`,
        ]) {
            expect(readEquation({ mathml })).toEqual(empty);
        }
    });

    // jsdom reports it as the root, as Firefox does; happy-dom inside the root, as Chrome does.
    test('a parse error inside the root reads as an empty equation, not as what parsed before it', () => {
        Object.assign(globalThis, { DOMParser: new Window().DOMParser });
        try {
            expect(readEquation({ mathml: `${MATH}<mi>x</mi>` }).row).toEqual([]);
        } finally {
            Object.assign(globalThis, { DOMParser: window.DOMParser });
        }
    });

    test('a string past the MathML cap is refused before it is parsed', () => {
        const padded = `${MATH}<mi>x</mi>${' '.repeat(MATH_LIMITS.mathmlLength)}</math>`;
        expect(readEquation({ mathml: padded }).row).toEqual([]);
        expect(readEquation({ mathml: `${MATH}<mi>x</mi></math>` }).row).toEqual(x);
    });

    test('a tree past a bound shows its LaTeX as text', () => {
        const mathml = `${MATH}<semantics><mrow>${tooDeep}</mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>`;
        const row: MathRow = [{ kind: 'text', text: 'x^2' }];
        expect(readEquation({ mathml })).toEqual({
            row,
            latex: 'x^2',
            mathml: writeMathml(row, 'x^2'),
            text: 'x^2',
            display: false,
        });
        expect(readEquation({ mathml: `${MATH}${tooDeep}</math>` }).row).toEqual([]);
    });

    test("the LaTeX's tabs and line breaks are spaces in the text, as in any tree's", () => {
        const latex = 'a\tb\nc';
        const mathml = `${MATH}<semantics><mrow>${tooDeep}</mrow><annotation encoding="application/x-tex">${latex}</annotation></semantics></math>`;
        const { row, latex: kept } = readEquation({ mathml });
        expect(row).toEqual([{ kind: 'text', text: 'a b c' }]);
        expect(kept).toBe(latex);
    });

    test('an annotation the writer refuses goes, and the tree stays', () => {
        const quotes = '"'.repeat(MATH_LIMITS.mathmlLength / 4);
        const mathml = `${MATH}<semantics><mi>x</mi><annotation encoding="application/x-tex">${quotes}</annotation></semantics></math>`;
        expect(mathml.length).toBeLessThan(MATH_LIMITS.mathmlLength);
        expect(readEquation({ mathml })).toEqual({
            row: x,
            latex: undefined,
            mathml: writeMathml(x),
            text: 'x',
            display: false,
        });
    });

    test('takes the caller’s parser', () => {
        expect(readEquation({ mathml: writeMathml(x) }, () => null).row).toEqual([]);
    });
});

describe('equation text', () => {
    test('its plain text is its linear form, typed or not, and an empty equation is nothing', () => {
        const serializers = { textSerializers: getTextSerializersFromSchema(schema) };
        const typed = '\\frac{x}{2}';
        expect(getText(equationDoc({ mathml: writeMathml(readLatex(typed), typed) }), serializers)).toBe('a x/2');
        expect(getText(equationDoc({ mathml: writeMathml(xSquared) }), serializers)).toBe('a x^2');
        expect(getText(equationDoc({ mathml: '' }), serializers)).toBe('a ');
    });

    // An input rule checks its match against textBetween, so an equation read there as text would be replaced.
    describe('typing after an equation never replaces it', () => {
        // A paragraph of `before`, an equation of `latex`, the caret after it; then `typed`, one key at a time, as
        // ProseMirror hands each to the input rules before inserting it.
        function typeAfter(before: string, latex: string, typed: string): ProseMirrorNode {
            const equation = { type: 'equation', attrs: { mathml: writeMathml(x, latex) } };
            const content = [
                { type: 'paragraph', content: [...(before ? [{ type: 'text', text: before }] : []), equation] },
            ];
            const editor = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
            editor.commands.setTextSelection(before.length + 2);
            for (const key of typed) {
                const { view } = editor;
                const { from, to } = view.state.selection;
                const insert = () => view.state.tr.insertText(key, from, to);
                if (!view.someProp('handleTextInput', (handle) => handle(view, from, to, key, insert))) {
                    view.dispatch(insert());
                }
            }
            const { doc } = editor.state;
            editor.destroy();
            return doc;
        }

        const read = (doc: ProseMirrorNode) =>
            doc.textBetween(0, doc.content.size, '', (leaf) => `[${readEquation(leaf.attrs).latex}]`);

        test('"(c" then ")" stays, not ©', () => {
            expect(read(typeAfter('light (', 'c', ')'))).toBe('light ([c])');
        });

        test('"-" then "-" stays, not an em dash', () => {
            expect(read(typeAfter('', '-', '-'))).toBe('[-]-');
        });

        test('a rule matched by the text typed after it still applies', () => {
            expect(read(typeAfter('', 'x', ' --'))).toBe('[x] —');
        });
    });
});

describe('equation commands', () => {
    // "a" at 1, an equation of x at 2.
    const editorOf = () =>
        new Editor({
            extensions: getDocExtensions(),
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'a' },
                            { type: 'equation', attrs: { mathml: writeMathml(x, 'x') } },
                        ],
                    },
                ],
            },
        });

    test('insertEquation puts an empty equation at the caret and selects it', () => {
        const editor = editorOf();
        editor.commands.setTextSelection(2);
        expect(editor.commands.insertEquation()).toBe(true);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
        expect(editor.state.doc.nodeAt(2)?.attrs).toEqual({ mathml: '', display: false, commentCardId: null });
        expect(editor.state.doc.nodeAt(3)?.attrs['mathml']).toBe(writeMathml(x, 'x'));
        editor.destroy();
    });

    test('insertEquation over a selected equation keeps it and puts the new one after it', () => {
        const editor = editorOf();
        editor.commands.setNodeSelection(2);
        editor.commands.insertEquation();
        expect(editor.state.doc.nodeAt(2)?.attrs['mathml']).toBe(writeMathml(x, 'x'));
        expect(editor.state.doc.nodeAt(3)?.attrs['mathml']).toBe('');
        expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 3 });
        editor.destroy();
    });

    test('updateEquation writes the selected equation and keeps it selected', () => {
        const editor = editorOf();
        editor.commands.setNodeSelection(2);
        expect(editor.commands.updateEquation({ mathml: writeMathml(xSquared, 'x^2'), display: true })).toBe(true);
        expect(editor.state.doc.nodeAt(2)?.attrs).toEqual({
            mathml: writeMathml(xSquared, 'x^2'),
            display: true,
            commentCardId: null,
        });
        expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
        editor.destroy();
    });

    // Shift and an arrow over the equation, or a drag across it, select it as text.
    test('updateEquation writes an equation selected as text', () => {
        const editor = editorOf();
        editor.commands.setTextSelection({ from: 2, to: 3 });
        expect(editor.commands.updateEquation({ display: true })).toBe(true);
        expect(editor.state.doc.nodeAt(2)?.attrs['display']).toBe(true);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 3 });
        editor.destroy();
    });

    // As a block insert splits it: an equation is no code, and the text after the caret stays code.
    test('insertEquation in a code block gives the equation a paragraph between its halves', () => {
        const lowlight = {
            highlight: () => ({ children: [] }),
            highlightAuto: () => ({ children: [] }),
            listLanguages: () => [],
        };
        const editor = new Editor({
            extensions: getDocExtensions({ lowlight }),
            content: {
                type: 'doc',
                content: [
                    { type: 'codeBlock', content: [{ type: 'text', text: 'abc' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'z' }] },
                ],
            },
        });
        editor.commands.setTextSelection(2);
        expect(editor.commands.insertEquation()).toBe(true);
        expect(
            editor.state.doc.children.map((block) => [
                block.type.name,
                block.children.map((n) => n.text ?? n.type.name),
            ]),
        ).toEqual([
            ['codeBlock', ['a']],
            ['paragraph', ['equation']],
            ['codeBlock', ['bc']],
            ['paragraph', ['z']],
        ]);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 4 });
        editor.destroy();
    });

    test('updateEquation without a selected equation writes nothing', () => {
        const editor = editorOf();
        editor.commands.setTextSelection(1);
        expect(editor.commands.updateEquation({ display: true })).toBe(false);
        expect(editor.state.doc.nodeAt(2)?.attrs['display']).toBe(false);
        editor.destroy();
    });
});
