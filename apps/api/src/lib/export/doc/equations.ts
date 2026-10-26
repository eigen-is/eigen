// A doc export's equations: the MathML the screen draws, or the SVG MathJax makes of it for the PDF, which WeasyPrint
// prints. One budget bounds what a render's readers pay for them. The doc renderer writes each equation through
// renderEquations, and the PDF draws its SVGs first, through svgEquations.

import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { escapeHtml } from '@workspace/lib/html';
import type { MathRow } from '@workspace/math';
import { writeMathml } from '@workspace/math';
import { readStoredEquation } from '../../document/equation';
import { MAX_SVG_EQUATIONS, mathmlToSvg, SVG_LIMIT } from '../math-svg';

// What a render's readers pay for an equation's drawing: the sanitizer's jsdom and WeasyPrint pay per element, and the
// PDF's SVG adds bytes no stored string holds.
type EquationCost = { elements: number; bytes: number };

export type EquationDrawing = EquationCost & { html: string };

// The sanitizer's jsdom pays 3 to 5 KB a MathML element in the transform process. The bytes cost no more than text.
export const MATHML_LIMIT = { elements: 50_000, bytes: Number.POSITIVE_INFINITY };

// One export's equations, the body's and its bands' spending one budget: the PDF's SVG drawings, else the MathML in the
// editor's span, whose rule lays a displayed one out on its line as the editor does.
export function renderEquations(svgs?: ReadonlyMap<string, EquationDrawing>): ({ node }: { node: Node }) => string {
    if (svgs) return renderBudgetedEquations((_attrs, key) => svgs.get(key), SVG_LIMIT);
    return renderBudgetedEquations((attrs) => {
        const { row, display } = readStoredEquation(attrs);
        const data = display ? ' data-display="block"' : '';
        return equationDrawing(`<span class="equation"${data}>${equationMathml(row, display)}</span>`);
    }, MATHML_LIMIT);
}

// WeasyPrint draws no MathML, so the PDF draws its equations as the SVGs MathJax makes of the MathML the screen draws,
// keyed by stored string, each drawn once, in the order the render meets them, the bands' first. Every copy spends
// SVG_LIMIT; MathJax stops at the first equation that does not fit, or past MAX_SVG_EQUATIONS drawings, and the render
// prints the rest as text.
export async function svgEquations(roots: JSONContent[]): Promise<Map<string, EquationDrawing>> {
    const drawings = new Map<string, EquationDrawing>();
    const fits = equationBudget(SVG_LIMIT);
    for (const attrs of equationAttrs(roots)) {
        const key = equationKey(attrs);
        let drawing = drawings.get(key);
        if (drawing === undefined && drawings.size < MAX_SVG_EQUATIONS) {
            const { row, display } = readStoredEquation(attrs);
            const svg = await mathmlToSvg(equationMathml(row, display));
            drawing = equationDrawing(`<span class="math-svg"${display ? ' data-display="block"' : ''}>${svg}</span>`);
        }
        if (drawing === undefined || !fits(drawing)) break;
        drawings.set(key, drawing);
    }
    return drawings;
}

// Without the annotation, which no screen draws and the sanitizer would keep as text; the PDF's MathJax draws it too.
export function equationMathml(row: MathRow, display: boolean): string {
    const math = writeMathml(row);
    return display ? math.replace('<math', '<math display="block"') : math;
}

// The render meets the equations in document order, each copy spending the budget and each distinct one drawn once,
// so a subtree it skips, which the schema refuses but a Yjs update can hold, moves no drawing onto another equation.
// From the first that does not fit, the rest print as their linear text, which costs no element.
function renderBudgetedEquations(
    draw: (attrs: Record<string, unknown>, key: string) => EquationDrawing | undefined,
    limit: EquationCost,
): ({ node }: { node: Node }) => string {
    const fits = equationBudget(limit);
    const drawings = new Map<string, EquationDrawing | undefined>();
    const texts = new Map<string, string>();
    let tail = false;
    return ({ node }) => {
        const key = equationKey(node.attrs);
        if (!tail) {
            if (!drawings.has(key)) drawings.set(key, draw(node.attrs, key));
            const drawing = drawings.get(key);
            if (drawing && fits(drawing)) return drawing.html;
            tail = true;
        }
        let text = texts.get(key);
        if (text === undefined) {
            text = escapeHtml(readStoredEquation(node.attrs).text);
            texts.set(key, text);
        }
        return text;
    };
}

function* equationAttrs(nodes: JSONContent[]): Generator<Record<string, unknown>> {
    for (const node of nodes) {
        if (node.type === 'equation') yield node.attrs ?? {};
        yield* equationAttrs(node.content ?? []);
    }
}

// A copy draws as the stored string and display it repeats.
function equationKey(attrs: Record<string, unknown>): string {
    return `${attrs['display'] === true}${typeof attrs['mathml'] === 'string' ? attrs['mathml'] : ''}`;
}

// Every copy spends, as each is read again. Once one does not fit, none does: the costs only grow.
function equationBudget(limit: EquationCost): (drawing: EquationCost) => boolean {
    const spent = { elements: 0, bytes: 0 };
    return (drawing) => {
        spent.elements += drawing.elements;
        spent.bytes += drawing.bytes;
        return spent.elements <= limit.elements && spent.bytes <= limit.bytes;
    };
}

function equationDrawing(html: string): EquationDrawing {
    return { html, elements: html.match(/<[a-z]/g)?.length ?? 0, bytes: Buffer.byteLength(html) };
}
