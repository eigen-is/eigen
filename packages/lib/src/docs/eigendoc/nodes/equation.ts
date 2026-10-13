import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
    fromDom,
    MATH_LIMITS,
    MATHML_NAMESPACE,
    MathError,
    type MathRow,
    type MathXmlElement,
    readMathml,
    readMathmlLatex,
    writeMathml,
} from '@workspace/math';

// `mathml` is what the writer wrote for the rest: the one string a consumer mounts.
export type Equation = { row: MathRow; latex: string | undefined; mathml: string; display: boolean };

type Read = Omit<Equation, 'display'>;

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
// Past a bound an equation shows its LaTeX as text, which below the size bound writes well within the MathML cap;
// else it reads as nothing.
function readMath(math: MathXmlElement): Read | undefined {
    const latex = unlessRefused(() => readMathmlLatex(math));
    const row = unlessRefused(() => readMathml(math).row);
    if (row) {
        const annotated = latex === undefined ? undefined : unlessRefused(() => writeMathml(row, latex));
        return annotated ? { row, latex, mathml: annotated } : { row, latex: undefined, mathml: writeMathml(row) };
    }
    if (latex === undefined || latex.length >= MATH_LIMITS.size) return undefined;
    const text: MathRow = [{ kind: 'text', text: latex }];
    return { row: text, latex, mathml: writeMathml(text, latex) };
}

// Every consumer's read of the attrs: the stored string is never mounted as is, and any string reads as an equation
// the writers can write. Only a string the writer could have written is parsed, so no prolog, DOCTYPE or entity
// reaches either parser. The server passes Bun's parser.
export function readEquation(
    attrs: Record<string, unknown>,
    parse: (mathml: string) => MathXmlElement | null = parseInBrowser,
): Equation {
    const display = attrs['display'] === true;
    const mathml = attrs['mathml'];
    const math =
        typeof mathml === 'string' && mathml.startsWith('<math') && mathml.length <= MATH_LIMITS.mathmlLength
            ? parse(mathml)
            : null;
    return { ...((math && readMath(math)) || EMPTY), display };
}

// Until the package writes an equation's linear text, its LaTeX stands in. Never the node's leafText: Tiptap's input
// rules compare their match with textBetween, so a leafText equal to the match's prefix would let a rule replace the
// equation.
export const equationText = (node: ProseMirrorNode) => readEquation(node.attrs).latex ?? '';

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
                getAttrs(dom) {
                    const read = readMath(fromDom(dom));
                    return read ? { mathml: read.mathml } : false;
                },
            },
            // One the package refuses parses as nothing rather than as its tokens' text.
            { tag: 'math', namespace: MATHML_NAMESPACE, ignore: true },
        ];
    },

    // In a span, phrasing content like the <math>, so a pasted copy keeps its paragraph whole. Browsers honour
    // contenteditable on HTML elements only, so on a bare <math> the caret would enter its tokens.
    renderHTML({ node }) {
        const { mathml, display } = readEquation(node.attrs);
        const math = new DOMParser().parseFromString(mathml, 'application/xml').documentElement;
        if (display) math.setAttribute('display', 'block');
        // Spelled like the comment mark's, so a cut equation keeps its card the way cut text does.
        if (node.attrs['commentCardId']) math.setAttribute('data-comment-id', node.attrs['commentCardId']);
        return ['span', { contenteditable: 'false' }, math];
    },

    renderText({ node }) {
        return equationText(node);
    },
});
