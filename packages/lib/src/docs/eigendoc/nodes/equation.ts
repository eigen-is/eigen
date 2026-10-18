import { type CommandProps, Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import {
    fromDom,
    MATH_LIMITS,
    MATHML_NAMESPACE,
    MathError,
    type MathRow,
    type MathXmlElement,
    mathText,
    readLatex,
    readMathml,
    readMathmlLatex,
    writeMathml,
    writeText,
} from '@workspace/math';

// `mathml` is what the writer wrote for the rest: the one string a consumer mounts. `text` is what it reads as where
// only text goes, the word count, a comment's quote, plain text and the search index: the tree's linear form, typed or
// not.
export type Equation = { row: MathRow; latex: string | undefined; mathml: string; text: string; display: boolean };

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        equation: {
            insertEquation: () => ReturnType;
            updateEquation: (attributes: { display: boolean }) => ReturnType;
        };
    }
}

type Read = Omit<Equation, 'text' | 'display'>;

const EMPTY: Read = { row: [], latex: undefined, mathml: writeMathml([]) };

// Either browser puts a parse error in the document instead of throwing: some as the root, others inside it.
function parseInBrowser(mathml: string): MathXmlElement | null {
    const doc = new DOMParser().parseFromString(mathml, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0 ? null : fromDom(doc.documentElement);
}

// The one catch around the package: a peer writes the stored attr, anyone the pasted HTML.
function unlessRefused<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        return undefined;
    }
}

// The annotation counts toward no bound, so only the writer weighs it, and one it refuses goes while the tree stays.
// Past a bound an equation shows its LaTeX as text, which within the size bound (the root row, the node and a part a
// character) writes well within the MathML caps; else it reads as nothing.
function readMath(math: MathXmlElement): Read | undefined {
    const latex = unlessRefused(() => readMathmlLatex(math));
    const row = unlessRefused(() => readMathml(math));
    if (row) {
        const annotated = latex === undefined ? undefined : unlessRefused(() => writeMathml(row, latex));
        return annotated ? { row, latex, mathml: annotated } : { row, latex: undefined, mathml: writeMathml(row) };
    }
    if (latex === undefined || latex.length > MATH_LIMITS.size - 2) return undefined;
    const text: MathRow = [{ kind: 'text', text: mathText(latex) }];
    return { row: text, latex, mathml: writeMathml(text, latex) };
}

// Whether a string could be the writer's: it starts at the root, and is no longer and holds no more tags or quotes than
// its output. Each < the writer writes is a tag, as it escapes the rest, and it quotes its attributes with " alone, so a
// ' inside a tag is no writer's. It escapes the > in text, so the next one ends the tag.
function isWritable(mathml: string): boolean {
    if (!mathml.startsWith('<math') || mathml.length > MATH_LIMITS.mathmlLength) return false;
    let tags = 0;
    let apostrophe = mathml.indexOf("'");
    for (let index = mathml.indexOf('<'); index >= 0; index = mathml.indexOf('<', index + 1)) {
        if (++tags > MATH_LIMITS.mathmlTags) return false;
        if (apostrophe >= 0 && apostrophe < index) apostrophe = mathml.indexOf("'", index);
        const close = mathml.indexOf('>', index);
        if (close < 0 || (apostrophe >= 0 && apostrophe < close)) return false;
    }
    let quotes = 0;
    for (let index = mathml.indexOf('"'); index >= 0; index = mathml.indexOf('"', index + 1)) {
        if (++quotes > MATH_LIMITS.mathmlQuotes) return false;
    }
    return true;
}

// Only a string the writer could have written is parsed, so no prolog, DOCTYPE or entity reaches either parser, and
// neither builds more elements than the writer writes: the stored attr, and MathML typed in the panel's field.
export function parseMathml(
    mathml: string,
    parse: (mathml: string) => MathXmlElement | null = parseInBrowser,
): MathXmlElement | null {
    return isWritable(mathml) ? parse(mathml) : null;
}

// Every consumer's read of the attrs: the stored string is never mounted as is, and any string reads as an equation
// the writers can write. The server passes Bun's parser.
export function readEquation(
    attrs: Record<string, unknown>,
    parse: (mathml: string) => MathXmlElement | null = parseInBrowser,
): Equation {
    const display = attrs['display'] === true;
    const mathml = attrs['mathml'];
    const math = typeof mathml === 'string' ? parseMathml(mathml, parse) : null;
    const read = (math && readMath(math)) || EMPTY;
    return { ...read, text: writeText(read.row), display };
}

// The <math> a browser draws: the writer's MathML, as a block when the equation is displayed.
export function equationMath({ mathml, display }: Pick<Equation, 'mathml' | 'display'>): Element {
    const math = new DOMParser().parseFromString(mathml, 'application/xml').documentElement;
    if (display) math.setAttribute('display', 'block');
    return math;
}

// A drawn equation holds a hidden copy of its <math> beside the glyphs or image: KaTeX's, MathJax 2's (Word for the
// web's, its CommonHTML output classed apart), MathJax 3's, MathJax 4's with its hidden MathML on, and Wikipedia's.
const MATH_HOLDERS = '.katex-mathml, .MJX_Assistive_MathML, mjx-assistive-mml, .mwe-math-mathml-a11y';
const MATH_DRAWINGS = '.katex, .MathJax, .MathJax_CHTML, .mwe-math-element';

// A paste of a drawn equation would hold its glyphs as text, or its image as a figure, beside it, so each drawing
// becomes its <math> alone. Only a <math> in a holder directly in a drawing counts, so a page's own element with a
// renderer's class keeps what else it holds, and the pasted root itself stays. A displayed one's outer wrapper holds
// only the drawing.
export function unwrapRenderedMath(root: ParentNode): void {
    for (const math of root.querySelectorAll('math')) {
        const drawing = math.parentElement?.matches(MATH_HOLDERS) ? math.parentElement.parentElement : null;
        if (drawing?.matches(MATH_DRAWINGS) && drawing !== root && root.contains(drawing)) drawing.replaceWith(math);
    }
}

export const EquationNode = Node.create({
    name: 'equation',

    group: 'inline',

    inline: true,

    atom: true,

    addAttributes() {
        return {
            // getAttrs reads it through the package, so a foreign `mathml` attribute never reaches the doc.
            mathml: { default: '', parseHTML: () => null },
            display: {
                default: false,
                parseHTML: (element: HTMLElement) => element.getAttribute('display') === 'block',
            },
            // As the figure's: the Yjs binding persists a mark only on text.
            commentCardId: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-id'),
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: 'math',
                namespace: MATHML_NAMESPACE,
                // A pasted annotation stays only as LaTeX the panel can edit.
                getAttrs(dom) {
                    const read = readMath(fromDom(dom));
                    if (!read) return false;
                    const { latex } = read;
                    const editable = latex === undefined || unlessRefused(() => readLatex(latex)) !== undefined;
                    return { mathml: editable ? read.mathml : writeMathml(read.row) };
                },
            },
            // One the package refuses parses as nothing rather than as its tokens' text.
            { tag: 'math', namespace: MATHML_NAMESPACE, ignore: true },
        ];
    },

    // In a span, phrasing content like the <math>, so a pasted copy keeps its paragraph whole. Browsers honour
    // contenteditable on HTML elements only, so on a bare <math> the caret would enter its tokens.
    renderHTML({ node }) {
        const math = equationMath(readEquation(node.attrs));
        // Spelled like the comment mark's, so a cut equation keeps its card the way cut text does.
        if (node.attrs['commentCardId']) math.setAttribute('data-comment-id', node.attrs['commentCardId']);
        return ['span', math];
    },

    // Never the node's leafText: Tiptap's input rules compare their match with textBetween, so a leafText equal to the
    // match's prefix would let a rule replace the equation.
    renderText({ node }) {
        return readEquation(node.attrs).text;
    },

    addCommands() {
        return {
            // An empty equation at the caret, selected; one selected stays, and the new one follows it. In a code
            // block, as a block insert there, the block splits at the caret and the equation takes a paragraph between.
            insertEquation:
                () =>
                ({ tr, dispatch, commands }: CommandProps) => {
                    if (tr.selection instanceof NodeSelection) commands.setTextSelection(tr.selection.to);
                    const { from, to, $from } = tr.selection;
                    const steps = tr.steps.length;
                    const equation = { type: this.name };
                    const content = $from.parent.type.spec.code ? { type: 'paragraph', content: [equation] } : equation;
                    if (!commands.insertContent(content)) return false;
                    if (dispatch) {
                        const mapping = tr.mapping.slice(steps);
                        tr.doc.nodesBetween(mapping.map(from, -1), mapping.map(to), (node, pos) => {
                            if (node.type.name === this.name) tr.setSelection(NodeSelection.create(tr.doc, pos));
                        });
                    }
                    return true;
                },
            // Every equation the selection holds, as a node or as text, or the one it selects, as updateFigure. Attribute
            // steps move no position, so the selection stays and the panel open.
            updateEquation:
                ({ display }) =>
                ({ tr, dispatch }: CommandProps) => {
                    const { from, to } = tr.selection;
                    const positions: number[] = [];
                    tr.doc.nodesBetween(from, to, (node, pos) => {
                        if (node.type.name === this.name && pos >= from) positions.push(pos);
                    });
                    if (dispatch) for (const pos of positions) tr.setNodeAttribute(pos, 'display', display);
                    return positions.length > 0;
                },
        };
    },
});

// A light editor's paste, which has no equation node: each <math>, from Docs or a drawing on the web, reads as its
// linear text, where ProseMirror would keep the text of its tokens and of its LaTeX annotation.
export function mathAsText(html: string): string {
    if (!html.includes('<math')) return html;
    const { body } = new DOMParser().parseFromString(html, 'text/html');
    unwrapRenderedMath(body);
    for (const math of body.querySelectorAll('math')) {
        const read = readMath(fromDom(math));
        math.replaceWith(read ? writeText(read.row) : '');
    }
    return body.innerHTML;
}
