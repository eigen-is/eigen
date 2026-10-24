import type { TextAlign, VerticalAlign } from '@workspace/lib/vector';
import { slidePxToPt } from '@workspace/lib/vector';
import { escapeXml } from '@workspace/lib/xml';
import { JSDOM } from 'jsdom';
import { canvasTextValue } from '../../../document/prose-css';
import { ALGN_BY_ALIGN, ANCHOR_BY_ALIGN, solidFillXml } from '../../../ooxml/drawingml';
import { AHYP_NS } from '../../../ooxml/ooxml';
import { uriReference } from '../../../ooxml/opc';
import { isElement } from '../../sanitize';
import type { Slide } from './package';
import { toEmu } from './shapes';

// Text: a box's HTML as the paragraphs and runs of a text body, laid out as canvas-text.css lays it out.

// Text sizes and spacing in 100ths of a point, at the deck's scale.
function centipoints(slide: Slide, px: number): number {
    return Math.round(slidePxToPt(px, slide.deck.slideWidth) * 100);
}

type Marks = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; href?: string };

export const NO_MARKS: Marks = { bold: false, italic: false, underline: false, strike: false };

// A '\n' run is a line break.
type Run = { text: string; marks: Marks };

type Paragraph = {
    runs: Run[];
    // List nesting, and whether this paragraph opens its item and so draws the marker.
    depth: number;
    marker?: 'bullet' | 'number';
    quotes: number;
    // canvas-text.css's `p + p` margin.
    spaceBefore: boolean;
};

// What a text body draws with: the box's typography, which every run and empty line writes in full.
type TextBox = {
    fontFamily: string;
    fontSize: number;
    color: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    letterSpacing: number;
    lineHeight: number;
    inset: number;
    wrap: boolean;
    opacity: number;
};

// The LightEditor's HTML as paragraphs, read the way canvas-text.css lays it out: whitespace collapses, a list item's
// first paragraph draws its marker, a quote indents.
export function paragraphsOf(html: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const lists: ('bullet' | 'number')[] = [];
    let current: Paragraph | undefined;
    let item = false;
    let quotes = 0;
    const open = (spaceBefore: boolean): Paragraph => {
        current = { runs: [], depth: lists.length, marker: item ? lists.at(-1) : undefined, quotes, spaceBefore };
        item = false;
        paragraphs.push(current);
        return current;
    };
    const walk = (node: Node, marks: Marks): void => {
        if (node.nodeType === 3) {
            const text = (node.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ');
            if (current || text.trim()) (current ?? open(false)).runs.push({ text, marks });
            return;
        }
        if (!isElement(node)) return;
        const tag = node.localName;
        const children = (inner: Marks) => {
            for (const child of node.childNodes) walk(child, inner);
        };
        if (tag === 'br') (current ?? open(false)).runs.push({ text: '\n', marks });
        else if (tag === 'strong') children({ ...marks, bold: true });
        else if (tag === 'em') children({ ...marks, italic: true });
        else if (tag === 'u') children({ ...marks, underline: true });
        else if (tag === 's') children({ ...marks, strike: true });
        else if (tag === 'a') children({ ...marks, underline: true, href: node.getAttribute('href') ?? undefined });
        else {
            current = undefined;
            if (tag === 'p') open(node.previousElementSibling?.localName === 'p');
            if (tag === 'li') item = true;
            if (tag === 'ul' || tag === 'ol') lists.push(tag === 'ol' ? 'number' : 'bullet');
            if (tag === 'blockquote') quotes++;
            children(marks);
            if (tag === 'ul' || tag === 'ol') lists.pop();
            if (tag === 'blockquote') quotes--;
            current = undefined;
        }
    };
    for (const node of JSDOM.fragment(html).childNodes) walk(node, NO_MARKS);
    if (paragraphs.length === 0) return [{ runs: [], depth: 0, quotes: 0, spaceBefore: false }];
    return paragraphs.map((paragraph) => ({ ...paragraph, runs: trimmed(paragraph.runs) }));
}

// A length canvas-text.css states in the unit the writer reads it in; a shorthand's first value.
function canvasTextLength(selector: string, property: string, unit: 'em' | 'px'): number {
    const [length = ''] = canvasTextValue(selector, property).split(/\s+/);
    if (!length.endsWith(unit)) throw new Error(`canvas-text.css ${property} on ${selector} is not in ${unit}`);
    return Number(length.slice(0, -unit.length));
}

// canvas-text.css: a list level's indent, a quote's indent past its bar, and the opacity a quote draws at.
const LIST_INDENT_EM = canvasTextLength('.eigen-canvas-text ul', 'padding-left', 'em');
// The marker's hang: a disc sits close to its text, a number right-aligned in the list's indent.
const MARKER_EM = { bullet: 0.75, number: 1.5 };
const QUOTE_INDENT_EM = canvasTextLength('.eigen-canvas-text blockquote', 'padding-left', 'em');
const QUOTE_BAR_PX = canvasTextLength('.eigen-canvas-text blockquote', 'border-left', 'px');
const QUOTE_OPACITY = Number(canvasTextValue('.eigen-canvas-text blockquote', 'opacity'));
const PARAGRAPH_GAP_EM = canvasTextLength('.eigen-canvas-text p + p', 'margin-top', 'em');
// The schema's ceilings, ST_TextSpacingPoint's and ST_TextMargin's, which a tall line or a deep nesting passes.
const MAX_SPACING = 158_400;
const MAX_MARGIN = 51_206_400;
// ST_TextIndentLevelType's deepest level, and ST_TextFontSize's range.
const MAX_LEVEL = 8;
const MIN_FONT_SIZE = 100;
const MAX_FONT_SIZE = 400_000;

export function textBodyXml(slide: Slide, paragraphs: Paragraph[], box: TextBox): string {
    const em = (n: number) => toEmu(slide, n * box.fontSize);
    const inset = toEmu(slide, box.inset);
    // An exact pitch, CSS's: what a consumer takes as a single line varies (LibreOffice draws 1.2em for every face).
    const pitch = Math.min(MAX_SPACING, centipoints(slide, box.lineHeight * box.fontSize));
    const lineSpacing = `<a:lnSpc><a:spcPts val="${pitch}"/></a:lnSpc>`;
    const body = paragraphs.map((paragraph) => {
        const margin = Math.min(
            MAX_MARGIN,
            em(paragraph.depth * LIST_INDENT_EM) +
                paragraph.quotes * (em(QUOTE_INDENT_EM) + toEmu(slide, QUOTE_BAR_PX)),
        );
        const indent = paragraph.marker ? -em(MARKER_EM[paragraph.marker]) : 0;
        const level = Math.min(MAX_LEVEL, Math.max(0, paragraph.depth - 1));
        const attrs = [
            margin ? ` marL="${margin}"` : '',
            indent ? ` indent="${indent}"` : '',
            level ? ` lvl="${level}"` : '',
            ` algn="${ALGN_BY_ALIGN[box.textAlign]}"`,
        ].join('');
        const spacing = paragraph.spaceBefore
            ? `<a:spcBef><a:spcPts val="${centipoints(slide, PARAGRAPH_GAP_EM * box.fontSize)}"/></a:spcBef>`
            : '';
        const marker =
            paragraph.marker === 'bullet'
                ? '<a:buChar char="•"/>'
                : paragraph.marker === 'number'
                  ? '<a:buAutoNum type="arabicPeriod"/>'
                  : '<a:buNone/>';
        const opacity = box.opacity * QUOTE_OPACITY ** paragraph.quotes;
        const runs = paragraph.runs.map((run) => {
            const props = runPropsXml(slide, 'a:rPr', box, run.marks, opacity);
            return run.text === '\n' ? `<a:br>${props}</a:br>` : `<a:r>${props}<a:t>${escapeXml(run.text)}</a:t></a:r>`;
        });
        const end = runPropsXml(slide, 'a:endParaRPr', box, NO_MARKS, opacity);
        return `<a:p><a:pPr${attrs}>${lineSpacing}${spacing}${marker}</a:pPr>${runs.join('')}${end}</a:p>`;
    });
    const wrap = box.wrap ? 'square' : 'none';
    return `<p:txBody><a:bodyPr wrap="${wrap}" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${ANCHOR_BY_ALIGN[box.verticalAlign]}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${body.join('')}</p:txBody>`;
}

// CSS drops the collapsed space at a block's start and end, then the block's last break, which starts no line.
function trimmed(runs: Run[]): Run[] {
    const first = runs.findIndex((run) => run.text !== '\n');
    const last = runs.findLastIndex((run) => run.text !== '\n');
    const out = runs
        .map((run, i) => {
            const start = i === first ? run.text.trimStart() : run.text;
            return { ...run, text: i === last ? start.trimEnd() : start };
        })
        .filter((run) => run.text !== '');
    if (out.at(-1)?.text === '\n') out.pop();
    return out;
}

function runPropsXml(slide: Slide, tag: 'a:rPr' | 'a:endParaRPr', box: TextBox, marks: Marks, opacity: number): string {
    const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, centipoints(slide, box.fontSize)));
    const spacing = centipoints(slide, box.letterSpacing);
    const attrs = [
        ` sz="${size}"`,
        box.bold || marks.bold ? ' b="1"' : '',
        box.italic || marks.italic ? ' i="1"' : '',
        box.underline || marks.underline ? ' u="sng"' : '',
        box.strike || marks.strike ? ' strike="sngStrike"' : '',
        spacing !== 0 ? ` spc="${spacing}"` : '',
    ].join('');
    const fill = solidFillXml(box.color, opacity);
    const face = escapeXml(box.fontFamily);
    const fonts = `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>`;
    // A link draws in the run's color, as canvas-text.css draws it: PowerPoint's own extension for that.
    const link =
        marks.href && tag === 'a:rPr'
            ? `<a:hlinkClick r:id="${slide.part.relate('hyperlink', uriReference(marks.href), true)}"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"><ahyp:hlinkClr xmlns:ahyp="${AHYP_NS}" val="tx"/></a:ext></a:extLst></a:hlinkClick>`
            : '';
    return `<${tag}${attrs} dirty="0">${fill}${fonts}${link}</${tag}>`;
}
