import type { CommandProps } from '@tiptap/core';
import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { MathXmlElement } from '@workspace/math';
import { fromDom, MATH_LIMITS, MATHML_NAMESPACE, readLatex, writeMathml, writeText } from '@workspace/math';
import type { Equation, MathRead } from './equation-paste';
import { readMath, unlessRefused } from './equation-paste';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        equation: {
            insertEquation: () => ReturnType;
            updateEquation: (attributes: { display: boolean }) => ReturnType;
        };
    }
}

const EMPTY: MathRead = { row: [], latex: undefined, mathml: writeMathml([]) };

// Either browser puts a parse error in the document instead of throwing: some as the root, others inside it.
function parseInBrowser(mathml: string): MathXmlElement | null {
    const doc = new DOMParser().parseFromString(mathml, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0 ? null : fromDom(doc.documentElement);
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
