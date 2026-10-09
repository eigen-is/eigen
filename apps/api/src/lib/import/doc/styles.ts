import { codeBlockLanguage, headingLevel, PAGE_SECTION_TYPES, STYLE_NAMES, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlElements } from '../../core/xml';
import { lowlight } from '../../document/lowlight';
import { FONT_SLOTS, type Fonts, type Script, type Theme } from './docx-fonts';
import { halfPoints, int, is, isOn, onOff, twips, w, wChild } from './package';

// '' is an explicit none (auto color, no highlight), undefined inherits.
export type RunProps = {
    style?: string;
    bold?: boolean;
    italic?: boolean;
    // A complex script character's own: Word draws Arabic or Hebrew, and all of a run marked rtl, with these.
    boldCs?: boolean;
    italicCs?: boolean;
    sizeCs?: number;
    caps?: boolean;
    smallCaps?: boolean;
    underline?: boolean;
    strike?: boolean;
    vertAlign?: string;
    color?: string;
    // The color is one of the theme's link colors, which Word's link look names.
    linkColor?: boolean;
    highlight?: string;
    shading?: string;
    fonts?: Fonts;
    size?: number;
    vanish?: boolean;
} & Script;

// The left border's width in eighths of a point, which tells the writer's quote bar from a rule beside the text.
type Borders = {
    top?: boolean;
    left?: boolean;
    bottom?: boolean;
    right?: boolean;
    bar?: number;
};

export type ParaProps = {
    style?: string;
    jc?: string;
    bidi?: boolean;
    numId?: string;
    ilvl?: number;
    indLeft?: number;
    // The first line's offset from the left indent: firstLine to the right, hanging (negative) to the left.
    indFirst?: number;
    pageBreakBefore?: boolean;
    outlineLvl?: number;
    borders?: Borders;
    shading?: string;
    exactLine?: number;
    markSize?: number;
    markHidden?: boolean;
    // A tracked deletion of the paragraph mark: accepted, the paragraph joins the next.
    markDeleted?: boolean;
    sectionBreak?: boolean;
    frame?: 'left' | 'right';
};

export const TOGGLES = ['bold', 'boldCs', 'italic', 'italicCs', 'caps', 'smallCaps', 'strike'] as const;

// ST_HighlightColor, the only names Word draws.
const HIGHLIGHT_COLORS = new Map([
    ['yellow', 'FFFF00'],
    ['green', '00FF00'],
    ['cyan', '00FFFF'],
    ['magenta', 'FF00FF'],
    ['blue', '0000FF'],
    ['red', 'FF0000'],
    ['darkBlue', '000080'],
    ['darkCyan', '008080'],
    ['darkGreen', '008000'],
    ['darkMagenta', '800080'],
    ['darkRed', '800000'],
    ['darkYellow', '808000'],
    ['darkGray', '808080'],
    ['lightGray', 'C0C0C0'],
    ['black', '000000'],
    ['white', 'FFFFFF'],
]);

export const LINK_THEME_COLORS = new Set(['hyperlink', 'followedHyperlink']);

// Six hex digits or nothing: `auto`, a theme name or a typo is an explicit none.
function hexColor(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return /^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : '';
}

export function shadingOf(shd: XmlElement | undefined): string | undefined {
    if (!shd) return undefined;
    const fill = hexColor(w(shd, 'fill'));
    if (fill) return fill;
    // A solid pattern paints the pattern color.
    return w(shd, 'val') === 'solid' ? (hexColor(w(shd, 'color')) ?? '') : '';
}

// White is no fill: Word and Google Docs spell an unshaded cell or paragraph that way too.
export function isFill(fill: string | undefined): boolean {
    return !!fill && fill !== 'FFFFFF';
}

// A light grey, as the editor's code fill and its re-saves are: each channel at least D0 and within 18 of the others.
export function isLightNeutral(fill: string | undefined): boolean {
    if (!fill || !isFill(fill)) return false;
    const channels = [0, 2, 4].map((at) => Number.parseInt(fill.slice(at, at + 2), 16));
    return Math.min(...channels) >= 0xd0 && Math.max(...channels) - Math.min(...channels) <= 0x18;
}

export function readRunProps(rPr: XmlElement | undefined, theme: Theme): RunProps {
    const props: RunProps = {};
    for (const child of rPr ? xmlElements(rPr) : []) {
        if (child.ns !== W_NS) continue;
        switch (child.local) {
            case 'rStyle':
                props.style = w(child, 'val');
                break;
            case 'b':
                props.bold = onOff(child);
                break;
            case 'i':
                props.italic = onOff(child);
                break;
            case 'bCs':
                props.boldCs = onOff(child);
                break;
            case 'iCs':
                props.italicCs = onOff(child);
                break;
            case 'caps':
                props.caps = onOff(child);
                break;
            case 'smallCaps':
                props.smallCaps = onOff(child);
                break;
            case 'strike':
            case 'dstrike':
                // A dstrike off must not undo a strike on.
                if (child.local === 'strike' || onOff(child)) props.strike = onOff(child);
                break;
            case 'u': {
                // MS-OI29500 §2.1.100c: Word reads a w:u without w:val, often only a color, as inherited.
                const value = w(child, 'val');
                if (value !== undefined) props.underline = value !== 'none';
                break;
            }
            case 'vertAlign':
                props.vertAlign = w(child, 'val');
                break;
            case 'color':
                props.color = hexColor(w(child, 'val'));
                props.linkColor = LINK_THEME_COLORS.has(w(child, 'themeColor') ?? '');
                break;
            case 'highlight':
                props.highlight = HIGHLIGHT_COLORS.get(w(child, 'val') ?? 'none') ?? '';
                break;
            case 'shd':
                props.shading = shadingOf(child);
                break;
            case 'rFonts': {
                const lang = wChild(rPr, 'lang');
                const fonts: Fonts = {};
                for (const slot of FONT_SLOTS) {
                    const themed = w(child, slot === 'cs' ? 'cstheme' : `${slot}Theme`);
                    const language = themed?.endsWith('Bidi')
                        ? w(lang, 'bidi')
                        : themed?.endsWith('EastAsia')
                          ? w(lang, 'eastAsia')
                          : undefined;
                    const font = (themed && theme.font(themed, language)) ?? w(child, slot);
                    if (font) fonts[slot] = font;
                }
                props.fonts = fonts;
                const hint = w(child, 'hint');
                if (hint) props.hint = hint;
                break;
            }
            case 'cs':
            case 'rtl':
                // Either marks the run complex script, drawn all in its cs face; an rtl off leaves a cs on.
                if (child.local === 'cs' || onOff(child)) props.complex = onOff(child);
                break;
            case 'sz':
                props.size = halfPoints(w(child, 'val'));
                break;
            case 'szCs':
                props.sizeCs = halfPoints(w(child, 'val'));
                break;
            case 'vanish':
                props.vanish = onOff(child);
                break;
        }
    }
    return props;
}

const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

export function readParaProps(pPr: XmlElement | undefined): ParaProps {
    const props: ParaProps = {};
    for (const child of pPr ? xmlElements(pPr) : []) {
        if (child.ns !== W_NS) continue;
        switch (child.local) {
            case 'pStyle':
                props.style = w(child, 'val');
                break;
            case 'jc':
                props.jc = w(child, 'val');
                break;
            case 'bidi':
                props.bidi = onOff(child);
                break;
            case 'numPr': {
                const numId = w(wChild(child, 'numId'), 'val');
                if (numId !== undefined) props.numId = numId;
                const ilvl = int(w(wChild(child, 'ilvl'), 'val'));
                if (ilvl !== undefined) props.ilvl = ilvl;
                break;
            }
            case 'ind': {
                // Each attribute inherits on its own: a w:ind of only a hanging keeps the style's left.
                const left = twips(w(child, 'left') ?? w(child, 'start'));
                if (left !== undefined) props.indLeft = left;
                const hanging = twips(w(child, 'hanging'));
                const first = hanging === undefined ? twips(w(child, 'firstLine')) : -hanging;
                if (first !== undefined) props.indFirst = first;
                break;
            }
            case 'pageBreakBefore':
                props.pageBreakBefore = onOff(child);
                break;
            case 'outlineLvl':
                props.outlineLvl = int(w(child, 'val'));
                break;
            case 'pBdr': {
                const borders: Borders = {};
                for (const side of BORDER_SIDES) {
                    const border = wChild(child, side);
                    if (border) borders[side] = !['nil', 'none'].includes(w(border, 'val') ?? 'none');
                }
                const left = wChild(child, 'left');
                if (left) borders.bar = int(w(left, 'sz'));
                props.borders = borders;
                break;
            }
            case 'shd':
                props.shading = shadingOf(child);
                break;
            case 'spacing': {
                const line = twips(w(child, 'line'));
                if (w(child, 'lineRule') === 'exact' && line !== undefined) props.exactLine = line;
                break;
            }
            case 'rPr':
                props.markSize = halfPoints(w(wChild(child, 'sz'), 'val'));
                props.markHidden = onOff(wChild(child, 'vanish'));
                props.markDeleted = !!(wChild(child, 'del') ?? wChild(child, 'moveFrom'));
                break;
            case 'framePr': {
                const wrap = w(child, 'wrap');
                if (wrap === 'none' || wrap === 'notBeside') break;
                const align = w(child, 'xAlign');
                props.frame = align === 'right' || align === 'outside' ? 'right' : 'left';
                break;
            }
            case 'sectPr': {
                const type = w(wChild(child, 'type'), 'val');
                props.sectionBreak = type === undefined || PAGE_SECTION_TYPES.has(type);
                break;
            }
        }
    }
    return props;
}

export function mergeRun(...layers: RunProps[]): RunProps {
    const merged: RunProps = {};
    for (const layer of layers) {
        const { fonts, ...rest } = layer;
        Object.assign(merged, rest);
        if (fonts) merged.fonts = { ...merged.fonts, ...fonts };
    }
    return merged;
}

export function mergePara(...layers: ParaProps[]): ParaProps {
    const merged: ParaProps = {};
    for (const layer of layers) {
        const { borders, ...rest } = layer;
        Object.assign(merged, rest);
        if (borders) merged.borders = { ...merged.borders, ...borders };
    }
    return merged;
}

// The styles other writers set code in (Word's HTML ones, pandoc's Source Code and Verbatim Char), plus Eigen's own;
// `Plain Text` is letters and survey routing, no code.
export const CODE_PARAGRAPH_STYLES = [STYLE_NAMES.CodeBlock, 'HTML Preformatted', 'Source Code', 'Code', 'Macro Text'];
export const CODE_CHARACTER_STYLES = [
    STYLE_NAMES.Code,
    'Verbatim Char',
    'HTML Code',
    'Source Text',
    'Terminal',
    'Code Char',
    'HTML Typewriter',
    'HTML Keyboard',
];

type Style = {
    id: string;
    type: string;
    // Lowercase: Word keeps the built-in names English but not their case.
    name: string;
    // The writer's carrier, from the name: a re-save may rename the id but keeps the name.
    language?: string;
    basedOn?: string;
    pPr: ParaProps;
    rPr: RunProps;
    firstRowRun?: RunProps;
    // A table style's cell fill, whole and in its first row.
    fill?: string;
    firstRowFill?: string;
};

// What a paragraph style means in eigendoc. Its look is the node's, so the props it absorbs are no marks.
export type Role =
    | { kind: 'heading'; level: number }
    | { kind: 'subtitle' }
    | { kind: 'quote' }
    | { kind: 'code'; language: string | null }
    | { kind: 'caption' }
    | { kind: 'taskDone' }
    | { kind: 'hr' }
    | { kind: 'structural' }
    | { kind: 'paragraph' };

const lowercase = (names: string[]) => names.map((name) => name.toLowerCase());

const ROLE_BY_NAME = new Map<string, Role>([
    // LibreOffice's parent of its numbered headings.
    ['title', { kind: 'heading', level: 1 }],
    ['heading', { kind: 'heading', level: 1 }],
    ['subtitle', { kind: 'subtitle' }],
    [STYLE_NAMES.Quote.toLowerCase(), { kind: 'quote' }],
    ['intense quote', { kind: 'quote' }],
    ...lowercase(CODE_PARAGRAPH_STYLES).map((name): [string, Role] => [name, { kind: 'code', language: null }]),
    [STYLE_NAMES.Caption.toLowerCase(), { kind: 'caption' }],
    [STYLE_NAMES.TaskDone.toLowerCase(), { kind: 'taskDone' }],
    [STYLE_NAMES.HorizontalRule.toLowerCase(), { kind: 'hr' }],
    [STYLE_NAMES.Spacer.toLowerCase(), { kind: 'structural' }],
    [STYLE_NAMES.PageBreak.toLowerCase(), { kind: 'structural' }],
]);

const CODE_CHARACTER_NAMES = new Set(lowercase(CODE_CHARACTER_STYLES));

function roleOf({ name, language }: Style): Role | undefined {
    const level = headingLevel(name);
    if (level) return { kind: 'heading', level: Math.min(6, level) };
    if (language) return { kind: 'code', language: lowlight.registered(language) ? language : null };
    return ROLE_BY_NAME.get(name);
}

// What the node draws itself: a heading its size and weight, so a style's italic or color stays a mark; a subtitle
// draws as a paragraph, and so does a caption, whose marks a figure drops as plain text and a paragraph keeps.
export const ABSORBED: Record<Role['kind'], (keyof RunProps)[] | 'all'> = {
    heading: ['bold', 'boldCs', 'size', 'sizeCs'],
    subtitle: [],
    quote: ['italic', 'italicCs', 'color'],
    code: 'all',
    caption: [],
    taskDone: ['strike', 'color'],
    hr: 'all',
    structural: 'all',
    paragraph: [],
};

// How far a basedOn or numStyleLink chain is followed: deeper than any a person builds, and each walk stays short.
export const MAX_CHAIN = 32;

// What a style answers once its basedOn chain is merged.
type Resolved = { run: RunProps; para: ParaProps; role: Role | undefined; code: boolean };

export class Styles {
    private readonly byId = new Map<string, Style>();
    private readonly resolved = new Map<string, Resolved>();
    readonly defaultParagraph: string | undefined;
    readonly docRun: RunProps;
    readonly docPara: ParaProps;

    constructor(root: XmlElement | undefined, theme: Theme) {
        let defaultParagraph: string | undefined;
        const defaults = wChild(root, 'docDefaults');
        this.docRun = readRunProps(wChild(wChild(defaults, 'rPrDefault'), 'rPr'), theme);
        this.docPara = readParaProps(wChild(wChild(defaults, 'pPrDefault'), 'pPr'));
        for (const element of root ? xmlElements(root) : []) {
            if (!is(element, W_NS, 'style')) continue;
            const id = w(element, 'styleId') ?? '';
            const type = w(element, 'type') ?? 'paragraph';
            const firstRow = xmlElements(element).find(
                (child) => is(child, W_NS, 'tblStylePr') && w(child, 'type') === 'firstRow',
            );
            const name = w(wChild(element, 'name'), 'val') ?? id;
            this.byId.set(id, {
                id,
                type,
                name: name.toLowerCase(),
                language: codeBlockLanguage(name),
                basedOn: w(wChild(element, 'basedOn'), 'val'),
                pPr: readParaProps(wChild(element, 'pPr')),
                rPr: readRunProps(wChild(element, 'rPr'), theme),
                firstRowRun: firstRow && readRunProps(wChild(firstRow, 'rPr'), theme),
                fill:
                    shadingOf(wChild(wChild(element, 'tcPr'), 'shd')) ??
                    shadingOf(wChild(wChild(element, 'tblPr'), 'shd')),
                firstRowFill: shadingOf(wChild(wChild(firstRow, 'tcPr'), 'shd')),
            });
            if (type === 'paragraph' && isOn(w(element, 'default'))) defaultParagraph ??= id;
        }
        this.defaultParagraph = defaultParagraph ?? (this.byId.has('Normal') ? 'Normal' : undefined);
    }

    get(id: string | undefined): Style | undefined {
        return id === undefined ? undefined : this.byId.get(id);
    }

    // Its chain, nearest first, ends at MAX_CHAIN or at the first repeat of a cycle.
    private resolve(id: string | undefined): Resolved {
        let resolved = this.resolved.get(id ?? '');
        if (resolved) return resolved;
        const chain: Style[] = [];
        for (
            let style = this.get(id);
            style && !chain.includes(style) && chain.length < MAX_CHAIN;
            style = this.get(style.basedOn)
        )
            chain.push(style);
        const rootFirst = [...chain].reverse();
        resolved = {
            run: mergeRun(...rootFirst.map((style) => style.rPr)),
            para: mergePara(...rootFirst.map((style) => style.pPr)),
            // The nearest style in the chain that names a role.
            role: chain.map(roleOf).find((role) => role !== undefined),
            code: chain.some((style) => CODE_CHARACTER_NAMES.has(style.name)),
        };
        this.resolved.set(id ?? '', resolved);
        return resolved;
    }

    run(id: string | undefined): RunProps {
        return this.resolve(id).run;
    }

    para(id: string | undefined): ParaProps {
        return this.resolve(id).para;
    }

    role(id: string | undefined): Role | undefined {
        return this.resolve(id).role;
    }

    isCodeCharacter(id: string | undefined): boolean {
        return this.resolve(id).code;
    }
}
