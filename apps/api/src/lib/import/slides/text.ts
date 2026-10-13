import { bundledFont } from '@workspace/lib/constants/fonts';
import { escapeHtml, LIGHT_EDITOR_HREF } from '@workspace/lib/html';
import {
    DEFAULT_RICHTEXT_PROPS,
    MAX_HTML_BYTES,
    SLIDES_STYLE_DEFAULTS,
    type TextAlign,
    TRANSPARENT_COLOR,
    type VectorRichTextElement,
    type VerticalAlign,
} from '@workspace/lib/vector';
import { drawingColor } from '../../core/drawingml';
import { A_NS, isAlternateContent, isOn, R_NS } from '../../core/ooxml';
import type { Relationship } from '../../core/opc';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../core/xml';
import { fillIn, paintOf, type SlideTheme } from './inherit';
import { alternative, type Lost } from './package';

// A text body → one rich-text box (SPEC X-D6): its HTML and the box's typography. Lost (Q2): per-run size, colour and
// font, per-paragraph size and indents, vertical text, columns, superscript, subscript and highlight.

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
    // The relationships of the part the shape is in, which name its links.
    rels: ReadonlyMap<string, Relationship>;
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

export const EMU_PER_POINT = 12_700;
// ECMA-376's default run size, 18 pt, in hundredths of a point.
const DEFAULT_SIZE = 1800;
// a:bodyPr's left and right inset where no body states one: 0.1 inch.
const DEFAULT_SIDE_INSET = 91_440;
// PowerPoint's single line spacing, as a CSS line height.
const SINGLE_LINE = DEFAULT_RICHTEXT_PROPS.lineHeight;

const ALIGNS = new Map<string, TextAlign>([
    ['l', 'left'],
    ['ctr', 'center'],
    ['r', 'right'],
    ['just', 'justify'],
    ['justLow', 'justify'],
    ['dist', 'justify'],
    ['thaiDist', 'justify'],
]);
const ANCHORS = new Map<string, VerticalAlign>([
    ['t', 'top'],
    ['ctr', 'center'],
    ['b', 'bottom'],
]);
const BULLETS = new Map<string, 'ul' | 'ol' | undefined>([
    ['buNone', undefined],
    ['buChar', 'ul'],
    ['buBlip', 'ul'],
    ['buAutoNum', 'ol'],
]);
const AUTOFITS = new Set(['normAutofit', 'noAutofit', 'spAutofit']);

type Marks = { bold: boolean; italic: boolean; underline: boolean; strike: boolean };
type RunStyle = Marks & { fontFamily: string; size: number; color: string; letterSpacing: number };
// Escaped text, or a <br> (no style: it takes its neighbours' marks).
type Run = { html: string; style?: RunStyle; href?: string };
type Paragraph = { list: 'ul' | 'ol' | undefined; level: number; runs: Run[]; text: boolean; chain: XmlElement[] };

// undefined when the body shows no text: an empty placeholder is not drawn.
export function richTextOf(
    source: TextSource,
    theme: SlideTheme,
    pxPerEmu: number,
    lost: Lost,
): RichTextFields | undefined {
    const bodies = [source.body, ...source.inherited];
    const lists = [...bodies.map((body) => xmlChild(body, A_NS, 'lstStyle')), source.listStyle].filter(
        (list) => list !== undefined,
    );
    const bodyPrs = bodies.flatMap((body) => xmlChild(body, A_NS, 'bodyPr') ?? []);
    const bodyAttr = (name: string) => firstOf(bodyPrs, (bodyPr) => xmlAttr(bodyPr, '', name));
    const autofit = bodyPrs.flatMap(xmlElements).find((child) => child.ns === A_NS && AUTOFITS.has(child.local));
    const normal = autofit?.local === 'normAutofit' ? autofit : undefined;
    const fontScale = fraction(normal && xmlAttr(normal, '', 'fontScale')) ?? 1;
    const lineReduction = fraction(normal && xmlAttr(normal, '', 'lnSpcReduction')) ?? 0;
    const fontRef = source.style && xmlChild(source.style, A_NS, 'fontRef');
    const context = { theme, pxPerEmu: pxPerEmu * fontScale, fontRef, rels: source.rels, lost };

    // Characters per run style, so the box takes the style most of its text is in.
    const covered = new Map<string, RunStyle & { chars: number }>();
    const paragraphs: Paragraph[] = [];
    for (const paragraph of xmlChildren(source.body, A_NS, 'p')) {
        const pPr = xmlChild(paragraph, A_NS, 'pPr');
        const lvl = Number((pPr && xmlAttr(pPr, '', 'lvl')) ?? 0);
        const level = Number.isInteger(lvl) && lvl >= 0 && lvl < 9 ? lvl : 0;
        const levels = lists.flatMap((list) =>
            [xmlChild(list, A_NS, `lvl${level + 1}pPr`), xmlChild(list, A_NS, 'defPPr')].filter(
                (entry) => entry !== undefined,
            ),
        );
        // PowerPoint draws a run without its own paragraph's defRPr, the style text typed into it would take.
        const inherited = levels.flatMap((entry) => xmlChild(entry, A_NS, 'defRPr') ?? []);
        const chain = pPr ? [pPr, ...levels] : levels;
        const bullet = chain.flatMap(xmlElements).find((child) => child.ns === A_NS && BULLETS.has(child.local));
        const runs: Run[] = [];
        let text = false;
        const children = xmlElements(paragraph).flatMap((child) =>
            isAlternateContent(child) ? alternative(child) : [child],
        );
        for (const child of children) {
            if (child.ns !== A_NS) continue;
            if (child.local === 'br') runs.push({ html: '<br>' });
            const t = (child.local === 'r' || child.local === 'fld') && xmlChild(child, A_NS, 't');
            if (!t) continue;
            const value = xmlText(t).replace(/[\t\r\n]/g, ' ');
            const rPr = xmlChild(child, A_NS, 'rPr');
            const style = runStyleOf(rPr, inherited, context);
            const key = JSON.stringify(style);
            const entry = covered.get(key) ?? { ...style, chars: 0 };
            entry.chars += value.replace(/\s/g, '').length;
            covered.set(key, entry);
            runs.push({ html: escapeHtml(value), style, href: linkOf(rPr, context.rels) });
            text ||= value.length > 0;
        }
        paragraphs.push({ list: bullet && BULLETS.get(bullet.local), level, runs, text, chain });
    }
    const [box] = [...covered.values()].sort((a, b) => b.chars - a.chars);
    if (!box || box.chars === 0) return undefined;

    const first = paragraphs.find((paragraph) => paragraph.text)?.chain ?? [];
    const lnSpc = firstOf(first, (pPr) => xmlChild(pPr, A_NS, 'lnSpc'));
    const percent = fraction(lnSpc && attrOf(xmlChild(lnSpc, A_NS, 'spcPct'), 'val'));
    const points = Number(lnSpc && attrOf(xmlChild(lnSpc, A_NS, 'spcPts'), 'val'));
    const inset = (name: string) => {
        const value = Number(bodyAttr(name));
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SIDE_INSET;
    };
    return {
        html: htmlOf(paragraphs, box),
        fontFamily: box.fontFamily,
        fontSize: box.size,
        fontWeight: box.bold ? 'bold' : 'normal',
        fontStyle: box.italic ? 'italic' : 'normal',
        textDecoration: box.underline ? 'underline' : box.strike ? 'line-through' : 'none',
        textAlign: ALIGNS.get(firstOf(first, (pPr) => xmlAttr(pPr, '', 'algn')) ?? '') ?? 'left',
        verticalAlign: ANCHORS.get(bodyAttr('anchor') ?? '') ?? 'top',
        color: box.color,
        letterSpacing: box.letterSpacing,
        // lnSpcReduction comes off a percentage; a spacing in points is the file's own.
        lineHeight:
            Number.isFinite(points) && points > 0
                ? ((points / 100) * EMU_PER_POINT * pxPerEmu) / box.size
                : SINGLE_LINE * Math.max(0, (percent ?? 1) - lineReduction),
        padding: ((inset('lIns') + inset('rIns')) / 2) * pxPerEmu,
    };
}

type RunContext = {
    theme: SlideTheme;
    // Scaled by normAutofit's fontScale.
    pxPerEmu: number;
    fontRef: XmlElement | undefined;
    rels: ReadonlyMap<string, Relationship>;
    lost: Lost;
};

// The run's own properties, else the shape style's fontRef for its font and colour, else what its level inherits.
function runStyleOf(rPr: XmlElement | undefined, inherited: XmlElement[], context: RunContext): RunStyle {
    const { theme, fontRef } = context;
    const chain = rPr ? [rPr, ...inherited] : inherited;
    const attr = (name: string) => firstOf(chain, (element) => xmlAttr(element, '', name));
    const number = (name: string) => {
        const value = Number(attr(name));
        return Number.isFinite(value) ? value : undefined;
    };
    const typefaceIn = (element: XmlElement) => attrOf(xmlChild(element, A_NS, 'latin'), 'typeface') || undefined;
    const colorIn = (element: XmlElement) => {
        const paint = paintOf(fillIn(element), theme, { lost: context.lost });
        const color = paint?.type === 'gradient' ? paint.from : paint?.color;
        // A run with no fill keeps its colour: text nobody can see is worse than a colour that differs.
        return color === TRANSPARENT_COLOR ? undefined : color;
    };
    const refIdx = fontRef && xmlAttr(fontRef, '', 'idx');
    const typeface =
        (rPr && typefaceIn(rPr)) ??
        (refIdx === 'major' ? '+mj-lt' : refIdx === 'minor' ? '+mn-lt' : undefined) ??
        firstOf(inherited, typefaceIn);
    const font = typeface === '+mj-lt' ? theme.fonts.major : typeface === '+mn-lt' ? theme.fonts.minor : typeface;
    const size = number('sz');
    const underline = attr('u');
    const strike = attr('strike');
    return {
        fontFamily: (font && bundledFont(font)) ?? SLIDES_STYLE_DEFAULTS.fontFamily,
        size: ((size !== undefined && size > 0 ? size : DEFAULT_SIZE) / 100) * EMU_PER_POINT * context.pxPerEmu,
        color:
            (rPr && colorIn(rPr)) ??
            (fontRef && drawingColor(fontRef, theme.colors)) ??
            firstOf(inherited, colorIn) ??
            SLIDES_STYLE_DEFAULTS.color,
        letterSpacing: ((number('spc') ?? 0) / 100) * EMU_PER_POINT * context.pxPerEmu,
        bold: isOn(attr('b')) ?? false,
        italic: isOn(attr('i')) ?? false,
        underline: underline !== undefined && underline !== 'none',
        strike: strike !== undefined && strike !== 'noStrike',
    };
}

// An external http, https or mailto target; a slide jump, a macro or a script is plain text.
function linkOf(rPr: XmlElement | undefined, rels: ReadonlyMap<string, Relationship>): string | undefined {
    const id = attrOf(rPr && xmlChild(rPr, A_NS, 'hlinkClick'), 'id', R_NS);
    const rel = id === undefined ? undefined : rels.get(id);
    return rel?.external && rel.type.endsWith('/hyperlink') && LIGHT_EDITOR_HREF.test(rel.target)
        ? rel.target
        : undefined;
}

type OpenList = { tag: 'ul' | 'ol'; level: number };

// A paragraph's HTML token by token: an entity, a tag or one character.
const HTML_TOKEN = /&[^;]*;|<[^>]*>|./gsu;

function htmlPrefix(html: string, bytes: number): string {
    let prefix = '';
    let used = 0;
    for (const [token] of html.matchAll(HTML_TOKEN)) {
        used += Buffer.byteLength(token);
        if (used > bytes) break;
        prefix += token;
    }
    return prefix;
}

// Bulleted paragraphs nest as lists by level, each list inside the item before it. Cut at a paragraph so the canvas
// reader keeps it whole, and every list still closed.
function htmlOf(paragraphs: Paragraph[], box: RunStyle): string {
    const closing = (open: OpenList[]) =>
        open
            .map((list) => `</li></${list.tag}>`)
            .reverse()
            .join('');
    let html = '';
    let bytes = 0;
    let open: OpenList[] = [];
    for (const paragraph of paragraphs) {
        const next = [...open];
        let piece = '';
        const { list, level } = paragraph;
        if (!list || !paragraph.text) {
            piece = closing(next.splice(0));
        } else {
            while ((next.at(-1)?.level ?? -1) > level) piece += closing(next.splice(-1));
            if (next.at(-1)?.level === level && next.at(-1)?.tag !== list) piece += closing(next.splice(-1));
            if (next.at(-1)?.level === level) {
                piece += '</li><li>';
            } else {
                piece += `<${list}><li>`;
                next.push({ tag: list, level });
            }
        }
        const inline = inlineOf(paragraph.runs, box);
        const size = Buffer.byteLength(`${piece}<p>${inline}</p>`);
        const room = MAX_HTML_BYTES - bytes - Buffer.byteLength(closing(next));
        if (size > room) {
            // A first paragraph too long to fit keeps its start, cut between tokens.
            if (!html)
                return `${piece}<p>${htmlPrefix(inline, room - (size - Buffer.byteLength(inline)))}</p>${closing(next)}`;
            break;
        }
        piece += `<p>${inline}</p>`;
        html += piece;
        bytes += size;
        open = next;
    }
    return html + closing(open);
}

// A run's marks where it differs from the box, neighbours with the same marks sharing their tags.
function inlineOf(runs: Run[], box: RunStyle): string {
    const decoration = box.underline ? 'underline' : box.strike ? 'strike' : undefined;
    let html = '';
    let current = '';
    let close = '';
    for (const run of runs) {
        if (run.style) {
            const { style, href } = run;
            const tags = [
                style.bold && !box.bold && 'strong',
                style.italic && !box.italic && 'em',
                style.underline && decoration !== 'underline' && 'u',
                style.strike && decoration !== 'strike' && 's',
            ].filter((tag) => tag !== false);
            const open = (href ? `<a href="${escapeHtml(href)}">` : '') + tags.map((tag) => `<${tag}>`).join('');
            if (open !== current) {
                html += close + open;
                current = open;
                close =
                    tags
                        .map((tag) => `</${tag}>`)
                        .reverse()
                        .join('') + (href ? '</a>' : '');
            }
        }
        html += run.html;
    }
    return html + close;
}

function firstOf<T>(elements: XmlElement[], read: (element: XmlElement) => T | undefined): T | undefined {
    for (const element of elements) {
        const found = read(element);
        if (found !== undefined) return found;
    }
    return undefined;
}

function attrOf(element: XmlElement | undefined, name: string, ns = ''): string | undefined {
    return element && xmlAttr(element, ns, name);
}

// ST_Percentage and its kin: thousandths of a percent, or Strict's '50%'; as a fraction.
function fraction(value: string | undefined): number | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const result = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed) / 100_000;
    return Number.isFinite(result) && result >= 0 ? result : undefined;
}
