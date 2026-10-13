import { afterAll, describe, expect, test } from 'bun:test';
import { createDocument, generateHTML, getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { MATH_LIMITS, MATHML_NAMESPACE, type MathRow, writeMathml } from '@workspace/math';
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
            `<p>a <math xmlns="${MATHML_NAMESPACE}" display="block" data-comment-id="card-1"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math></p>`,
        );
    });

    test('never mounts the stored string: what the writer does not write is gone', () => {
        const forged = `${MATH}<mi onclick="alert(1)">x</mi><script>alert(2)</script><foreignObject><img src="a.png"/></foreignObject></math>`;
        const html = generateHTML(equationDoc({ mathml: forged }).toJSON(), getDocExtensions());
        expect(html).toBe(`<p>a ${MATH}<mi>x</mi></math></p>`);
    });

    test('an empty equation renders an empty <math> for the node view to box', () => {
        expect(generateHTML(equationDoc({}).toJSON(), getDocExtensions())).toBe(`<p>a ${MATH}</math></p>`);
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
    test('reads a stored equation to its tree, LaTeX and display', () => {
        expect(readEquation({ mathml: writeMathml(xSquared, 'x^2'), display: true })).toEqual({
            row: xSquared,
            latex: 'x^2',
            display: true,
        });
    });

    test('a value of the wrong type reads as an empty inline equation', () => {
        expect(readEquation({ mathml: 7, display: 'true' })).toEqual({ row: [], latex: undefined, display: false });
    });

    test('an empty or malformed string reads as an empty equation', () => {
        for (const mathml of ['', `${MATH}<mi>x</mi>`, 'x^2']) {
            expect(readEquation({ mathml })).toEqual({ row: [], latex: undefined, display: false });
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
        expect(readEquation({ mathml })).toEqual({
            row: [{ kind: 'text', text: 'x^2' }],
            latex: 'x^2',
            display: false,
        });
        expect(readEquation({ mathml: `${MATH}${tooDeep}</math>` }).row).toEqual([]);
    });

    test('an annotation the writer refuses reads as an empty equation', () => {
        const quotes = '"'.repeat(MATH_LIMITS.mathmlLength / 4);
        const mathml = `${MATH}<semantics><mi>x</mi><annotation encoding="application/x-tex">${quotes}</annotation></semantics></math>`;
        expect(mathml.length).toBeLessThan(MATH_LIMITS.mathmlLength);
        const { row, latex } = readEquation({ mathml });
        expect(() => writeMathml(row, latex)).not.toThrow();
        expect({ row, latex }).toEqual({ row: [], latex: undefined });
    });

    test('takes the caller’s parser', () => {
        expect(readEquation({ mathml: 'anything' }, () => null).row).toEqual([]);
    });
});

describe('equation text', () => {
    test('the LaTeX is its text for textBetween and getText, else nothing', () => {
        const doc = equationDoc({ mathml: writeMathml(xSquared, 'x^2') });
        expect(doc.textBetween(0, doc.content.size)).toBe('a x^2');
        expect(getText(doc, { textSerializers: getTextSerializersFromSchema(schema) })).toBe('a x^2');
        expect(equationDoc({ mathml: writeMathml(xSquared) }).textBetween(0, doc.content.size)).toBe('a ');
    });
});
