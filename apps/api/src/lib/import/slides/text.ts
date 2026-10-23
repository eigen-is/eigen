import { bundledFont } from '@workspace/lib/constants/fonts';
import { escapeHtml, LIGHT_EDITOR_HREF } from '@workspace/lib/html';
import {
    DEFAULT_RICHTEXT_PROPS,
    MAX_HTML_BYTES,
    SLIDES_STYLE_DEFAULTS,
    snapSlideFontSize,
    type TextAlign,
    TRANSPARENT_COLOR,
    type VectorRichTextElement,
    type VerticalAlign,
} from '@workspace/lib/vector';
import { percent } from '../../core/drawingml';
import { A_NS, EMU_PER_POINT, emu, isAlternateContent, isOn, R_NS } from '../../core/ooxml';
import type { Relationship } from '../../core/opc';
import { type XmlElement, xmlAttr, xmlElements, xmlText } from '../../core/xml';
import { colorOf, fillIn, paintOf, type ShapeProperties, type SlideTheme } from './inherit';
import { charge, childOf, childrenOf, firstChildOf, prefixedAttrOf } from './lookup';
import { alternative, type DeckWalk, type Lost } from './package';

// A text body → one rich-text box (SPEC X-D6): its HTML and the box's typography. Lost (Q2): per-run size, colour and
// font, per-paragraph size and indents, stacked and East Asian vertical text, columns, superscript, subscript and
// highlight.

// What a text body inherits from, nearest first (SPEC X-D4).
export type TextSource = {
    // The shape's own p:txBody.
    body: XmlElement;
    // The bodyPr and lstStyle of the layout's and the master's placeholder it inherits from, read with their part.
    inherited: Pick<ShapeProperties, 'bodyPr' | 'listStyle'>[];
    // The master's p:titleStyle, p:bodyStyle or p:otherStyle, or the presentation's p:defaultTextStyle.
    listStyle: XmlElement | undefined;
    // The p:style the shape or its placeholder chain states, whose fontRef names a theme font and a colour.
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

function isBullet(child: XmlElement): boolean {
    return child.ns === A_NS && BULLETS.has(child.local);
}

function isAutofit(child: XmlElement): boolean {
    return child.ns === A_NS && AUTOFITS.has(child.local);
}

type Marks = { bold: boolean; italic: boolean; underline: boolean; strike: boolean };
type RunStyle = Marks & { fontFamily: string; size: number; color: string; letterSpacing: number };
// Escaped text, or a <br> (no style: it takes its neighbours' marks).
type Run = { html: string; style?: RunStyle; href?: string };
type Paragraph = { list: 'ul' | 'ol' | undefined; level: number; runs: Run[]; text: boolean; chain: XmlElement[] };

// undefined when the body shows no text: an empty placeholder is not drawn. Each paragraph, its children and each run's
// characters are charged to the read's work before they are read: a run costs however little it shows.
export function richTextOf(
    source: TextSource,
    theme: SlideTheme,
    deck: Pick<DeckWalk, 'scale' | 'slideWidth'>,
    lost: Lost,
): RichTextFields | undefined {
    const pxPerEmu = deck.scale;
    const bodies = bodiesOf(source);
    const shapeLists = bodies.flatMap((body) => body.listStyle ?? []);
    const bodyPrs = bodies.flatMap((body) => body.bodyPr ?? []);
    const bodyAttr = (name: string) => firstOf(bodyPrs, (bodyPr) => xmlAttr(bodyPr, '', name));
    const autofit = firstOf(bodyPrs, (bodyPr) => firstChildOf(bodyPr, isAutofit));
    const normal = autofit?.local === 'normAutofit' ? autofit : undefined;
    const fontScale = share(normal && xmlAttr(normal, '', 'fontScale')) ?? 1;
    const lineReduction = share(normal && xmlAttr(normal, '', 'lnSpcReduction')) ?? 0;
    const fontRef = source.style && childOf(source.style, A_NS, 'fontRef');
    const context = { theme, pxPerEmu: pxPerEmu * fontScale, fontRef, rels: source.rels, lost };

    // Characters per run style, so the box takes the style most of its text is in.
    const covered = new Map<string, RunStyle & { chars: number }>();
    const paragraphs: Paragraph[] = [];
    // The runs' HTML so far in UTF-16 units, each at least a byte: past the cap the canvas keeps, it is cut anyway.
    let html = 0;
    for (const paragraph of childrenOf(source.body, A_NS, 'p')) {
        const pPr = childOf(paragraph, A_NS, 'pPr');
        const lvl = Number((pPr && xmlAttr(pPr, '', 'lvl')) ?? 0);
        const level = Number.isInteger(lvl) && lvl >= 0 && lvl < 9 ? lvl : 0;
        const levelsOf = (list: XmlElement) =>
            [childOf(list, A_NS, `lvl${level + 1}pPr`), childOf(list, A_NS, 'defPPr')].filter(
                (entry) => entry !== undefined,
            );
        const shapeLevels = shapeLists.flatMap(levelsOf);
        const textLevels = source.listStyle ? levelsOf(source.listStyle) : [];
        // PowerPoint ignores a paragraph's own defRPr.
        const defaults = (levels: XmlElement[]) => levels.flatMap((entry) => childOf(entry, A_NS, 'defRPr') ?? []);
        const inherited = { shape: defaults(shapeLevels), text: defaults(textLevels) };
        const levels = [...shapeLevels, ...textLevels];
        const chain = pPr ? [pPr, ...levels] : levels;
        const bullet = firstOf(chain, (entry) => firstChildOf(entry, isBullet));
        const runs: Run[] = [];
        let text = false;
        const children = xmlElements(paragraph).flatMap((child) =>
            isAlternateContent(child) ? alternative(child) : [child],
        );
        charge(1 + children.length);
        for (const child of children) {
            if (child.ns !== A_NS) continue;
            if (child.local === 'br' && html <= MAX_HTML_BYTES) {
                runs.push({ html: '<br>' });
                html += 4;
            }
            const t = (child.local === 'r' || child.local === 'fld') && childOf(child, A_NS, 't');
            if (!t) continue;
            const raw = xmlText(t);
            charge(t.children.length + raw.length);
            const value = raw.replace(/[\t\r\n]/g, ' ');
            const rPr = childOf(child, A_NS, 'rPr');
            const style = runStyleOf(rPr, inherited, context);
            const key = JSON.stringify(style);
            const entry = covered.get(key) ?? { ...style, chars: 0 };
            entry.chars += value.replace(/\s/g, '').length;
            covered.set(key, entry);
            text ||= value.length > 0;
            if (html > MAX_HTML_BYTES) continue;
            const escaped = escapeHtml(value.slice(0, MAX_HTML_BYTES + 1 - html));
            html += escaped.length;
            runs.push({ html: escaped, style, href: linkOf(rPr, context.rels) });
        }
        paragraphs.push({ list: bullet && BULLETS.get(bullet.local), level, runs, text, chain });
    }
    const counted = [...covered.values()].filter((style) => style.chars > 0);
    const [box] = counted.sort((a, b) => b.chars - a.chars);
    if (!box) return undefined;
    // A mark is the box's only when every character has it: the editor can't take one off a run.
    const every = (mark: keyof Marks) => counted.every((style) => style[mark]);
    const marks: Marks = {
        bold: every('bold'),
        italic: every('italic'),
        underline: every('underline'),
        strike: every('strike'),
    };

    const first = paragraphs.find((paragraph) => paragraph.text)?.chain ?? [];
    const lnSpc = firstOf(first, (pPr) => childOf(pPr, A_NS, 'lnSpc'));
    const spacing = share(lnSpc && attrOf(childOf(lnSpc, A_NS, 'spcPct'), 'val'));
    const points = Number(lnSpc && attrOf(childOf(lnSpc, A_NS, 'spcPts'), 'val'));
    // Where the box takes it, the run's size is snapped: a 44 pt title shows 44 pt, not 44.000000001.
    const fontSize = snapSlideFontSize(box.size, deck.slideWidth);
    const inset = (name: string) => {
        const value = emu(bodyAttr(name));
        return value !== undefined && value >= 0 ? value : DEFAULT_SIDE_INSET;
    };
    return {
        html: htmlOf(paragraphs, marks),
        fontFamily: box.fontFamily,
        fontSize,
        fontWeight: marks.bold ? 'bold' : 'normal',
        fontStyle: marks.italic ? 'italic' : 'normal',
        textDecoration: marks.underline ? 'underline' : marks.strike ? 'line-through' : 'none',
        textAlign: ALIGNS.get(firstOf(first, (pPr) => xmlAttr(pPr, '', 'algn')) ?? '') ?? 'left',
        verticalAlign: ANCHORS.get(bodyAttr('anchor') ?? '') ?? 'top',
        color: box.color,
        letterSpacing: box.letterSpacing,
        // lnSpcReduction comes off a percentage; a spacing in points is the file's own.
        lineHeight:
            Number.isFinite(points) && points > 0
                ? ((points / 100) * EMU_PER_POINT * pxPerEmu) / fontSize
                : SINGLE_LINE * Math.max(0, (spacing ?? 1) - lineReduction),
        padding: ((inset('lIns') + inset('rIns')) / 2) * pxPerEmu,
    };
}

// a:bodyPr's vert as the turn the text takes over its shape's.
const VERTICAL_TURNS = new Map([
    ['horz', 0],
    ['vert', 90],
    ['vert270', 270],
]);
// East Asian and Mongolian vertical text turn Latin script as vert does; WordArt's stacked letters are drawn across.
const APPROXIMATE_TURNS = new Map([
    ['eaVert', 90],
    ['mongolianVert', 90],
    ['wordArtVert', 0],
    ['wordArtVertRtl', 0],
]);

export function verticalTurnOf(source: TextSource, lost: Lost): number {
    const bodyPr = bodiesOf(source)
        .flatMap((body) => body.bodyPr ?? [])
        .find((found) => xmlAttr(found, '', 'vert') !== undefined);
    const vert = (bodyPr && xmlAttr(bodyPr, '', 'vert')) ?? 'horz';
    const approximate = APPROXIMATE_TURNS.get(vert);
    if (bodyPr && approximate !== undefined) {
        lost('text-simplified');
        return approximate;
    }
    return VERTICAL_TURNS.get(vert) ?? 0;
}

// The shape's own body first, then its placeholders'.
function bodiesOf(source: TextSource): TextSource['inherited'] {
    const own = { bodyPr: childOf(source.body, A_NS, 'bodyPr'), listStyle: childOf(source.body, A_NS, 'lstStyle') };
    return [own, ...source.inherited];
}

type RunContext = {
    theme: SlideTheme;
    // Scaled by normAutofit's fontScale.
    pxPerEmu: number;
    fontRef: XmlElement | undefined;
    rels: ReadonlyMap<string, Relationship>;
    lost: Lost;
};

// A run's defRPr chain at its level: the shape's and its placeholders' list styles, then the master's text style or the
// presentation's default.
type Inherited = { shape: XmlElement[]; text: XmlElement[] };

// The run's own properties, else what its level inherits. The shape style's fontRef colour comes beneath the shape's
// list styles and its font beneath every one, as LibreOffice draws it.
function runStyleOf(rPr: XmlElement | undefined, inherited: Inherited, context: RunContext): RunStyle {
    const { theme, fontRef } = context;
    const chain = [...(rPr ? [rPr] : []), ...inherited.shape, ...inherited.text];
    const attr = (name: string) => firstOf(chain, (element) => xmlAttr(element, '', name));
    const number = (name: string) => {
        const value = Number(attr(name));
        return Number.isFinite(value) ? value : undefined;
    };
    const typefaceIn = (element: XmlElement) => attrOf(childOf(element, A_NS, 'latin'), 'typeface') || undefined;
    const colorIn = (element: XmlElement) => {
        const paint = paintOf(fillIn(element), theme, { lost: context.lost });
        const color = paint?.type === 'gradient' ? paint.from : paint?.color;
        // A run with no fill keeps its colour: text nobody can see is worse than a colour that differs.
        return color === TRANSPARENT_COLOR ? undefined : color;
    };
    const refIdx = fontRef && xmlAttr(fontRef, '', 'idx');
    const typeface =
        firstOf(chain, typefaceIn) ?? (refIdx === 'major' ? '+mj-lt' : refIdx === 'minor' ? '+mn-lt' : undefined);
    const font = typeface === '+mj-lt' ? theme.fonts.major : typeface === '+mn-lt' ? theme.fonts.minor : typeface;
    const size = number('sz');
    const underline = attr('u');
    const strike = attr('strike');
    return {
        fontFamily: (font && bundledFont(font)) ?? SLIDES_STYLE_DEFAULTS.fontFamily,
        size: ((size !== undefined && size > 0 ? size : DEFAULT_SIZE) / 100) * EMU_PER_POINT * context.pxPerEmu,
        color:
            (rPr && colorIn(rPr)) ??
            firstOf(inherited.shape, colorIn) ??
            colorOf(fontRef, theme.colors) ??
            firstOf(inherited.text, colorIn) ??
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
    const click = rPr && childOf(rPr, A_NS, 'hlinkClick');
    const id = click && prefixedAttrOf(click, R_NS, 'id');
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
function htmlOf(paragraphs: Paragraph[], marks: Marks): string {
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
        const inline = inlineOf(paragraph.runs, marks);
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

// A run's marks the box lacks, neighbours with the same marks sharing their tags.
function inlineOf(runs: Run[], box: Marks): string {
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

function attrOf(element: XmlElement | undefined, name: string): string | undefined {
    return element && xmlAttr(element, '', name);
}

// A share no smaller than none: a font scale, a line spacing.
function share(value: string | undefined): number | undefined {
    const fraction = percent(value);
    return fraction !== undefined && fraction >= 0 ? fraction : undefined;
}
