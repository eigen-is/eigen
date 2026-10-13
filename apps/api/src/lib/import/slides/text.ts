import { bundledFont } from '@workspace/lib/constants/fonts';
import { escapeHtml } from '@workspace/lib/html';
import {
    DEFAULT_RICHTEXT_PROPS,
    MAX_HTML_BYTES,
    SLIDES_STYLE_DEFAULTS,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { drawingColor } from '../../core/drawingml';
import { A_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../core/xml';
import type { SlideTheme } from './inherit';

// A text body → one rich-text box (SPEC X-D6): its HTML and the box's typography.

// What a text body inherits from, nearest first (SPEC X-D4).
export type TextSource = {
    // The shape's own p:txBody.
    body: XmlElement;
    // The p:txBody of the layout's and the master's placeholder it inherits from.
    inherited: XmlElement[];
    // The master's p:titleStyle, p:bodyStyle or p:otherStyle, or the presentation's p:defaultTextStyle.
    listStyle: XmlElement | undefined;
    // The shape's p:style, whose fontRef names a theme font and a colour.
    style: XmlElement | undefined;
};

export type RichTextFields = Pick<
    VectorRichTextElement,
    | 'html'
    | 'fontFamily'
    | 'fontSize'
    | 'fontWeight'
    | 'fontStyle'
    | 'textDecoration'
    | 'textAlign'
    | 'verticalAlign'
    | 'color'
    | 'letterSpacing'
    | 'lineHeight'
    | 'padding'
>;

const EMU_PER_POINT = 12_700;
// ECMA-376's default run size, 18 pt, in hundredths of a point.
const DEFAULT_SIZE = 1800;

type RunStyle = { size: number; fontFamily: string; color: string };

// undefined when the body shows no text: an empty placeholder is not drawn.
export function richTextOf(source: TextSource, theme: SlideTheme, pxPerEmu: number): RichTextFields | undefined {
    // Characters per run style, so the box takes the style most of its text is in.
    const covered = new Map<string, RunStyle & { chars: number }>();
    let html = '';
    let bytes = 0;
    for (const paragraph of xmlChildren(source.body, A_NS, 'p')) {
        let line = '';
        for (const child of xmlElements(paragraph)) {
            if (child.ns !== A_NS) continue;
            if (child.local === 'br') line += '<br>';
            const t = (child.local === 'r' || child.local === 'fld') && xmlChild(child, A_NS, 't');
            if (!t) continue;
            const text = xmlText(t);
            const style = runStyle(xmlChild(child, A_NS, 'rPr'), theme, pxPerEmu);
            const key = `${style.size} ${style.fontFamily} ${style.color}`;
            const entry = covered.get(key) ?? { ...style, chars: 0 };
            entry.chars += text.trim().length;
            covered.set(key, entry);
            line += escapeHtml(text);
        }
        const next = `<p>${line}</p>`;
        // Cut at a paragraph: the canvas reader keeps no more, and would tear a tag.
        bytes += Buffer.byteLength(next);
        if (bytes > MAX_HTML_BYTES) break;
        html += next;
    }
    const [majority] = [...covered.values()].sort((a, b) => b.chars - a.chars);
    if (!majority || majority.chars === 0) return undefined;
    return {
        ...DEFAULT_RICHTEXT_PROPS,
        html,
        fontFamily: majority.fontFamily,
        fontSize: majority.size,
        color: majority.color,
    };
}

function runStyle(rPr: XmlElement | undefined, theme: SlideTheme, pxPerEmu: number): RunStyle {
    const size = Number(rPr && xmlAttr(rPr, '', 'sz'));
    const typeface = rPr && xmlAttr(xmlChild(rPr, A_NS, 'latin') ?? rPr, '', 'typeface');
    const font = typeface === '+mj-lt' ? theme.fonts.major : typeface === '+mn-lt' ? theme.fonts.minor : typeface;
    return {
        size: ((Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE) / 100) * EMU_PER_POINT * pxPerEmu,
        fontFamily: (font && bundledFont(font)) ?? SLIDES_STYLE_DEFAULTS.fontFamily,
        color: drawingColor(rPr && xmlChild(rPr, A_NS, 'solidFill'), theme.colors) ?? SLIDES_STYLE_DEFAULTS.color,
    };
}
