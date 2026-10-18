import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDocument, Editor, generateHTML, getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { MATH_LIMITS, MATHML_NAMESPACE, type MathRow, readLatex, writeMathml, writeText } from '@workspace/math';
import { Window } from 'happy-dom';
import { JSDOM } from 'jsdom';
import { getDocExtensions, mathAsText, readEquation, unwrapRenderedMath } from '../../../../docs/eigendoc';

// jsdom's, since happy-dom's HTML parser puts a <math> in the XHTML namespace, where a browser's puts it in MathML's.
const { window } = new JSDOM();
const previous = {
    window: globalThis.window,
    document: globalThis.document,
    DOMParser: globalThis.DOMParser,
};
Object.assign(globalThis, {
    window,
    document: window.document,
    DOMParser: window.DOMParser,
});
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

const nodeNamesIn = (doc: ProseMirrorNode) => {
    const names: string[] = [];
    doc.descendants((node) => {
        names.push(node.type.name);
    });
    return names;
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

    // The panel edits the annotation, so one it can't read would open as an error the user never typed.
    test('a TeX annotation readLatex refuses goes, and the tree stays', () => {
        const html = `<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">\\mymacro{x}</annotation></semantics></math></p>`;
        expect(parsed(html)).toEqual([{ mathml: writeMathml(x), display: false, commentCardId: null }]);
    });

    // An HTML parser keeps the control character a reference names, which XML can't hold.
    test('an annotation holding a control character goes, and the tree stays', () => {
        const html = `<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x&#1;</annotation></semantics></math></p>`;
        expect(parsed(html)).toEqual([{ mathml: writeMathml(x), display: false, commentCardId: null }]);
    });
});

// A page that draws its math pastes each equation twice, as its <math> and as the glyphs or image drawn from it, and
// the docs paste unwraps each drawing first (`cleanPastedHTML`).
describe('a drawn equation pastes as its <math> alone', () => {
    const pasted = (html: string) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        unwrapRenderedMath(doc.body);
        return createDocument(doc.body.innerHTML, schema);
    };
    const equation = (latex: string, display: boolean, annotation?: string) => ({
        mathml: writeMathml(readLatex(latex), annotation),
        display,
        commentCardId: null,
    });

    // Word for the web's text/html for a displayed matrix, copied alone, with only its style attributes taken out:
    // MathJax 2's drawn spans, the equation again in data-mathml, and the hidden <math> with Word's mfenced.
    test("Word for the web's equation pastes once, displayed as Word marks it", () => {
        const html = readFileSync(
            join(import.meta.dir, '../../../fixtures/clipboard/word-web-display-equation.html'),
            'utf8',
        );
        const doc = pasted(html);
        expect(equationsIn(doc)).toEqual([equation('A=\\begin{pmatrix}1&0\\\\0&\\lambda\\end{pmatrix}', true)]);
        expect(doc.textContent).toBe('');
    });

    const XMLNS = `xmlns="${MATHML_NAMESPACE}"`;
    const xSquaredMath = `<msup><mi>x</mi><mn>2</mn></msup>`;
    const katexMath = (display: string) =>
        `<math ${XMLNS}${display}><semantics><mrow>${xSquaredMath}</mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>`;
    const katex = (display: string) =>
        `<span class="katex"><span class="katex-mathml">${katexMath(display)}</span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut"></span><span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span><span class="pstrut"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span>`;

    test.each([
        [
            // Constructed from the display sample's shape without MathJax_Display, until an inline capture exists.
            'Word for the web inline',
            `<p>a <span class="MathJax" data-mathml="&lt;math ${XMLNS}&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;" role="presentation"><nobr aria-hidden="true"><span class="math"><span class="mi">𝑥</span></span></nobr><span class="MJX_Assistive_MathML" role="presentation"><math ${XMLNS}><mi>x</mi></math></span></span> b</p>`,
            equation('x', false),
        ],
        [
            'MathJax 2 CommonHTML',
            `<p>a <span class="mjx-chtml MathJax_CHTML" data-mathml="&lt;math ${XMLNS}&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;/math&gt;" role="presentation"><span class="mjx-math" aria-hidden="true"><span class="mjx-mrow"><span class="mjx-mi"><span class="mjx-char MJXc-TeX-math-I">x</span></span></span></span><span class="MJX_Assistive_MathML" role="presentation"><math ${XMLNS}><mi>x</mi></math></span></span> b</p>`,
            equation('x', false),
        ],
        ['KaTeX inline', `<p>a ${katex('')} b</p>`, equation('x^2', false, 'x^2')],
        [
            'MathJax 3, and 4 with its hidden MathML on',
            `<p>a <mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true"><mjx-msup><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I">𝑥</mjx-c></mjx-mi><mjx-script><mjx-mn class="mjx-n" size="s"><mjx-c class="mjx-c32">2</mjx-c></mjx-mn></mjx-script></mjx-msup></mjx-math><mjx-assistive-mml unselectable="on" display="inline"><math ${XMLNS}>${xSquaredMath}</math></mjx-assistive-mml></mjx-container> b</p>`,
            equation('x^2', false),
        ],
        [
            // Its annotation's \displaystyle reads as nothing, so the panel edits it.
            'Wikipedia, its fallback image dropped',
            `<p>a <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math ${XMLNS} alttext="{\\displaystyle x^{2}}"><semantics><mrow class="MJX-TeXAtom-ORD"><mstyle displaystyle="true" scriptlevel="0"><msup><mi>x</mi><mrow class="MJX-TeXAtom-ORD"><mn>2</mn></mrow></msup></mstyle></mrow><annotation encoding="application/x-tex">{\\displaystyle x^{2}}</annotation></semantics></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/x" class="mwe-math-fallback-image-inline" aria-hidden="true" alt="{\\displaystyle x^{2}}"></span> b</p>`,
            equation('x^2', false, '{\\displaystyle x^{2}}'),
        ],
    ])('%s pastes once, inline in its sentence', (_source, html, expected) => {
        const doc = pasted(html);
        expect(equationsIn(doc)).toEqual([expected]);
        expect(nodeNamesIn(doc)).not.toContain('figure');
        expect(doc.textContent).toBe('a  b');
    });

    // MathJax 4 turns its hidden MathML off by default, so the page holds only the glyphs.
    test('MathJax 4 by default pastes as its text', () => {
        const doc = pasted(
            `<p>a <mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true"><mjx-msup><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I">𝑥</mjx-c></mjx-mi><mjx-script><mjx-mn class="mjx-n" size="s"><mjx-c class="mjx-c32">2</mjx-c></mjx-mn></mjx-script></mjx-msup></mjx-math></mjx-container> b</p>`,
        );
        expect(equationsIn(doc)).toEqual([]);
        expect(doc.textContent).toBe('a 𝑥2 b');
    });

    test('KaTeX displayed pastes once, displayed', () => {
        const doc = pasted(`<span class="katex-display">${katex(' display="block"')}</span>`);
        expect(equationsIn(doc)).toEqual([equation('x^2', true, 'x^2')]);
        expect(doc.textContent).toBe('');
    });

    // A page may give its own element a renderer's class: what holds two equations is no one equation's drawing.
    test("an element with a renderer's class around two equations keeps both and the text between", () => {
        const doc = pasted(
            `<div class="MathJax"><p><math ${XMLNS}><mi>x</mi></math> and <math ${XMLNS}><mi>x</mi></math></p></div>`,
        );
        expect(equationsIn(doc)).toEqual([equation('x', false), equation('x', false)]);
        expect(doc.textContent).toBe(' and ');
    });

    test("an element with a renderer's class around one equation and other text keeps the text", () => {
        const doc = pasted(
            `<div class="MathJax"><p>Intro.</p><p>See <math ${XMLNS}><mi>x</mi></math></p><p>Outro.</p></div><article class="katex"><h1>Title</h1><p>Body <span class="katex-mathml"><math ${XMLNS}><mi>x</mi></math></span></p></article>`,
        );
        expect(equationsIn(doc)).toEqual([equation('x', false), equation('x', false)]);
        expect(doc.textContent).toBe('Intro.See Outro.TitleBody ');
    });

    test("the pasted body keeps its place though it carries a renderer's class", () => {
        const doc = new DOMParser().parseFromString(
            `<html><body class="katex"><span class="katex-mathml">${katexMath('')}</span></body></html>`,
            'text/html',
        );
        unwrapRenderedMath(doc.body);
        expect(doc.body).not.toBeNull();
        expect(doc.body.querySelectorAll('math').length).toBe(1);
    });

    test('4,000 equations in one wrapper unwrap in linear time', () => {
        const html = `<div class="MathJax">${`<p><math ${XMLNS}><mi>x</mi></math></p>`.repeat(4000)}</div>`;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const start = performance.now();
        unwrapRenderedMath(doc.body);
        expect(performance.now() - start).toBeLessThan(500);
        expect(doc.body.querySelectorAll('math').length).toBe(4000);
    });
});

// A comment's, a mail's or a slide's editor has no equation node, so ProseMirror would keep the text of each token
// and of the LaTeX annotation.
describe('an equation pasted where no equation node is', () => {
    const lightSchema = getSchema(getDocExtensions({ exclude: ['equation'] }));
    const pasted = (html: string) => createDocument(mathAsText(html), lightSchema).textContent;

    test("a docs copy reads as the equation's linear text", () => {
        const row = readLatex('x^2+\\frac{a}{b}');
        const copied = generateHTML(
            schema
                .nodeFromJSON({
                    type: 'doc',
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                { type: 'text', text: 'see ' },
                                { type: 'equation', attrs: { mathml: writeMathml(row, 'x^2+\\frac{a}{b}') } },
                                { type: 'text', text: ' here' },
                            ],
                        },
                    ],
                })
                .toJSON(),
            getDocExtensions(),
        );
        expect(pasted(copied)).toBe(`see ${writeText(row)} here`);
    });

    test("a drawn equation from the web reads as its linear text alone, without the drawing's glyphs", () => {
        const katex = `<p>a <span class="katex"><span class="katex-mathml">${MATH}<msup><mi>x</mi><mn>2</mn></msup></math></span><span class="katex-html" aria-hidden="true">x2</span></span> b</p>`;
        expect(pasted(katex)).toBe(`a ${writeText(xSquared)} b`);
    });

    test('an annotation holding a control character keeps the equation, as the docs editor does', () => {
        const html = `<p>${MATH}<semantics><mi>x</mi><annotation encoding="application/x-tex">x&#1;</annotation></semantics></math></p>`;
        expect(pasted(html)).toBe('x');
    });

    test('HTML with no equation passes as it is', () => {
        expect(mathAsText('<p>a <b>b</b></p>')).toBe('<p>a <b>b</b></p>');
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

    // Each < the writer writes is a tag, so a string holding more than it writes is no writer's.
    test('a string with more tags than the writer writes is refused before it is parsed', () => {
        const parsedStrings: string[] = [];
        const parse = (mathml: string) => {
            parsedStrings.push(mathml);
            return null;
        };
        const tagged = (tags: number) => `${MATH}${'<a/>'.repeat(tags - 2)}</math>`;
        readEquation({ mathml: tagged(MATH_LIMITS.mathmlTags + 1) }, parse);
        expect(parsedStrings).toEqual([]);
        readEquation({ mathml: tagged(MATH_LIMITS.mathmlTags) }, parse);
        expect(parsedStrings).toEqual([tagged(MATH_LIMITS.mathmlTags)]);
    });

    // The writer quotes with " alone, at most three attributes a tag, so these are no writer's.
    test("a ' inside a tag, or more quotes than the writer writes, is refused before it is parsed", () => {
        const parsedStrings: string[] = [];
        const parse = (mathml: string) => {
            parsedStrings.push(mathml);
            return null;
        };
        readEquation({ mathml: `${MATH}<mi a='1'>x</mi></math>` }, parse);
        const attributes = Array.from({ length: 50 }, (_, index) => ` a${index}=""`).join('');
        const dense = `${MATH}${`<mi${attributes}>x</mi>`.repeat(Math.floor(MATH_LIMITS.mathmlQuotes / 100) + 1)}</math>`;
        expect(dense.length).toBeLessThan(MATH_LIMITS.mathmlLength);
        readEquation({ mathml: dense }, parse);
        expect(parsedStrings).toEqual([]);
        const apostrophe = `${MATH}<mtext>it's</mtext></math>`;
        readEquation({ mathml: apostrophe }, parse);
        expect(parsedStrings).toEqual([apostrophe]);
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

    // A text node of the LaTeX is the root row, the node and a part a character, so it reads back as a tree.
    test('LaTeX shown as text is at most the size bound less its row and node', () => {
        const shown = (latex: string) =>
            readEquation({
                mathml: `${MATH}<semantics><mrow>${tooDeep}</mrow><annotation encoding="application/x-tex">${latex}</annotation></semantics></math>`,
            }).row;
        const longest = 'x'.repeat(MATH_LIMITS.size - 2);
        expect(shown(longest)).toEqual([{ kind: 'text', text: longest }]);
        expect(shown(`${longest}x`)).toEqual([]);
    });

    test('an annotation the writer refuses goes, and the tree stays', () => {
        // Five characters read, the six the writer writes: past its cap.
        const quotes = '&#34;'.repeat(Math.floor(MATH_LIMITS.mathmlLength / 6));
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
        expect(editor.commands.updateEquation({ display: true })).toBe(true);
        expect(editor.state.doc.nodeAt(2)?.attrs).toEqual({
            mathml: writeMathml(x, 'x'),
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
