import type { MathRow, MathXmlElement } from '@workspace/math';
import {
    fromDom,
    MATH_LIMITS,
    MathError,
    mathText,
    readMathml,
    readMathmlLatex,
    writeMathml,
    writeText,
} from '@workspace/math';

// The read of a <math> without the node or the LaTeX reader, so a light editor's paste leaves both out of its bundle.

// `mathml` is what the writer wrote for the rest: the one string a consumer mounts. `text` is what it reads as where
// only text goes, the word count, a comment's quote, plain text and the search index: the tree's linear form, typed or
// not.
export type Equation = { row: MathRow; latex: string | undefined; mathml: string; text: string; display: boolean };

export type MathRead = Omit<Equation, 'text' | 'display'>;

// The one catch around the package: a peer writes the stored attr, anyone the pasted HTML.
export function unlessRefused<T>(read: () => T): T | undefined {
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
export function readMath(math: MathXmlElement): MathRead | undefined {
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
