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

// The node's attribute set as stored: `mathml` in the package's dialect, the typed LaTeX as its x-tex annotation.
export type EquationAttrs = {
    mathml: string;
    display: boolean;
    commentCardId: string | null;
};

export type Equation = { row: MathRow; latex: string | undefined; display: boolean };

// Either browser puts a parse error in the document instead of throwing: some as the root, others inside it.
function parseInBrowser(mathml: string): MathXmlElement | null {
    const doc = new DOMParser().parseFromString(mathml, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0 ? null : fromDom(doc.documentElement);
}

// The one catch around the package: a peer writes the stored attr, anyone the pasted HTML. Past a bound an equation
// shows its LaTeX as text, which below the size bound writes well within the MathML cap; else it reads as nothing.
function readMath(math: MathXmlElement): { row: MathRow; latex: string | undefined } | undefined {
    let latex: string | undefined;
    try {
        latex = readMathmlLatex(math);
        const { row } = readMathml(math);
        // The annotation counts toward no bound, so only the writer weighs it.
        writeMathml(row, latex);
        return { row, latex };
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
    }
    return latex !== undefined && latex.length < MATH_LIMITS.size
        ? { row: [{ kind: 'text', text: latex }], latex }
        : undefined;
}

// Every consumer's read of the attrs: the stored string is never mounted as is, and any string reads as an equation
// the writers can write. The server passes Bun's parser.
export function readEquation(
    attrs: Record<string, unknown>,
    parse: (mathml: string) => MathXmlElement | null = parseInBrowser,
): Equation {
    const display = attrs['display'] === true;
    const mathml = attrs['mathml'];
    const math = typeof mathml === 'string' && mathml.length <= MATH_LIMITS.mathmlLength ? parse(mathml) : null;
    const read = math && readMath(math);
    return read ? { ...read, display } : { row: [], latex: undefined, display };
}

// Until the package writes an equation's linear text, its LaTeX stands in.
const equationText = (node: ProseMirrorNode) => readEquation(node.attrs).latex ?? '';

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

    // ProseMirror's textBetween reads leafText, a field TipTap's config lacks.
    extendNodeSchema(extension) {
        return extension.name === this.name ? { leafText: equationText } : {};
    },

    parseHTML() {
        return [
            {
                tag: 'math',
                namespace: MATHML_NAMESPACE,
                getAttrs(dom) {
                    const read = readMath(fromDom(dom));
                    return read ? { mathml: writeMathml(read.row, read.latex) } : false;
                },
            },
            // One the package refuses parses as nothing rather than as its tokens' text.
            { tag: 'math', namespace: MATHML_NAMESPACE, ignore: true },
        ];
    },

    // No wrapper: a <math> is phrasing content, so a pasted copy keeps its paragraph whole.
    renderHTML({ node }) {
        const { row, latex, display } = readEquation(node.attrs);
        const math = new DOMParser().parseFromString(writeMathml(row, latex), 'application/xml').documentElement;
        if (display) math.setAttribute('display', 'block');
        // Spelled like the comment mark's, so a cut equation keeps its card the way cut text does.
        if (node.attrs['commentCardId']) math.setAttribute('data-comment-id', node.attrs['commentCardId']);
        return { dom: math };
    },

    renderText({ node }) {
        return equationText(node);
    },
});
