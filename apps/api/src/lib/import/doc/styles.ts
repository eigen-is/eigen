// The docx reader's run and paragraph property readers, and the Styles chain that resolves a style's properties through
// its basedOn parents, docDefaults and the table's conditional looks. The paragraph, run and table readers read every
// property through it.

import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlElements } from '../../core/xml';
import { lowlight } from '../../document/lowlight';
import { isOn, W_NS } from '../../ooxml/ooxml';
import {
    BORDER_SIDES,
    codeBlockLanguage,
    headingLevel,
    LINK_THEME_COLORS,
    PAGE_SECTION_TYPES,
    STYLE_NAMES,
} from '../../ooxml/wordml';
import { hexColor } from './colors';
import type { Fonts, Script, Theme } from './docx-fonts';
import { FONT_SLOTS } from './docx-fonts';
import { halfPointsOf, onOff, roundedInt, twipsOf, w, wChild } from './package';

// '' is an explicit none (auto color, no highlight), undefined inherits.
export type DocxRunProps = {
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
    // link: the color is one of the theme's link colors, which Word's link look names.
    color?: { hex: string; link: boolean };
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
    indRight?: number;
    // The first line's offset from the left indent: firstLine to the right, hanging (negative) to the left.
    indFirst?: number;
    pageBreakBefore?: boolean;
    outlineLvl?: number;
    borders?: Borders;
    shading?: string;
    exactLine?: number;
    // In twips; an auto line in 240ths of a line.
    line?: number;
    lineRule?: string;
    before?: number;
    after?: number;
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

export function shadingOf(shd: XmlElement | undefined): string | undefined {
    if (!shd) return undefined;
    // nil is no shading, whatever fill it names: none, which wins over a table's or a style's.
    const val = w(shd, 'val');
    if (val === 'nil') return '';
    // Solid paints the pattern color. An auto one is black, with Word's auto text white on it; the fill stands in for
    // it, so auto text stays legible in the body color.
    return (val === 'solid' && hexColor(w(shd, 'color'))) || (hexColor(w(shd, 'fill')) ?? '');
}

export function readRunProps(rPr: XmlElement | undefined, theme: Theme): DocxRunProps {
    const props: DocxRunProps = {};
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
            case 'color': {
                const hex = hexColor(w(child, 'val'));
                if (hex !== undefined) props.color = { hex, link: LINK_THEME_COLORS.has(w(child, 'themeColor') ?? '') };
                break;
            }
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
                props.size = halfPointsOf(w(child, 'val'));
                break;
            case 'szCs':
                props.sizeCs = halfPointsOf(w(child, 'val'));
                break;
            case 'vanish':
                props.vanish = onOff(child);
                break;
        }
    }
    return props;
}

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
                const ilvl = roundedInt(w(wChild(child, 'ilvl'), 'val'));
                if (ilvl !== undefined) props.ilvl = ilvl;
                break;
            }
            case 'ind': {
                // Each attribute inherits on its own: a w:ind of only a hanging keeps the style's left.
                const left = twipsOf(w(child, 'left') ?? w(child, 'start'));
                if (left !== undefined) props.indLeft = left;
                const right = twipsOf(w(child, 'right') ?? w(child, 'end'));
                if (right !== undefined) props.indRight = right;
                const hanging = twipsOf(w(child, 'hanging'));
                const first = hanging === undefined ? twipsOf(w(child, 'firstLine')) : -hanging;
                if (first !== undefined) props.indFirst = first;
                break;
            }
            case 'pageBreakBefore':
                props.pageBreakBefore = onOff(child);
                break;
            case 'outlineLvl':
                props.outlineLvl = roundedInt(w(child, 'val'));
                break;
            case 'pBdr': {
                const borders: Borders = {};
                for (const side of BORDER_SIDES) {
                    const border = wChild(child, side);
                    if (border) borders[side] = !['nil', 'none'].includes(w(border, 'val') ?? 'none');
                }
                const left = wChild(child, 'left');
                if (left) borders.bar = roundedInt(w(left, 'sz'));
                props.borders = borders;
                break;
            }
            case 'shd':
                props.shading = shadingOf(child);
                break;
            case 'spacing': {
                const line = twipsOf(w(child, 'line'));
                const lineRule = w(child, 'lineRule') ?? 'auto';
                if (line !== undefined) {
                    props.line = line;
                    props.lineRule = lineRule;
                }
                if (lineRule === 'exact' && line !== undefined) props.exactLine = line;
                const before = twipsOf(w(child, 'before'));
                if (before !== undefined) props.before = before;
                const after = twipsOf(w(child, 'after'));
                if (after !== undefined) props.after = after;
                break;
            }
            case 'rPr':
                props.markSize = halfPointsOf(w(wChild(child, 'sz'), 'val'));
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

export function mergeRun(...layers: DocxRunProps[]): DocxRunProps {
    const merged: DocxRunProps = {};
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
    rPr: DocxRunProps;
    firstRowRun?: DocxRunProps;
    // A table style's cell fill, whole and in its first row.
    fill?: string;
    firstRowFill?: string;
};

// What a paragraph style means in eigendoc. Its look is the node's, so the props it absorbs are no marks.
export type Role =
    | { kind: 'heading'; level: number }
    | { kind: 'title' }
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
    ['heading', { kind: 'heading', level: 1 }],
    [STYLE_NAMES.Title.toLowerCase(), { kind: 'title' }],
    [STYLE_NAMES.Subtitle.toLowerCase(), { kind: 'subtitle' }],
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

// What each node draws itself, so no mark; its own color and italic are nodeLook's, which paragraphs.ts reads.
export const ABSORBED: Record<Role['kind'], (keyof DocxRunProps)[] | 'all'> = {
    heading: ['bold', 'boldCs', 'size', 'sizeCs'],
    title: ['size', 'sizeCs'],
    subtitle: ['size', 'sizeCs'],
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

// A table style's looks: its cells' fill, and its first row's run props and fill.
type TableLook = { fill?: string; firstRowRun: DocxRunProps; firstRowFill?: string };

// What a style answers once its basedOn chain is merged.
type Resolved = { run: DocxRunProps; para: ParaProps; role: Role | undefined; code: boolean; table: TableLook };

export class Styles {
    private readonly byId = new Map<string, Style>();
    // By id as given: a style with no w:styleId is '', no style undefined.
    private readonly resolved = new Map<string | undefined, Resolved>();
    public readonly defaultParagraph: string | undefined;
    public readonly docRun: DocxRunProps;
    public readonly docPara: ParaProps;

    public constructor(root: XmlElement | undefined, theme: Theme) {
        let defaultParagraph: string | undefined;
        const defaults = wChild(root, 'docDefaults');
        this.docRun = readRunProps(wChild(wChild(defaults, 'rPrDefault'), 'rPr'), theme);
        this.docPara = readParaProps(wChild(wChild(defaults, 'pPrDefault'), 'pPr'));
        for (const element of root ? xmlElements(root) : []) {
            if (!hasXmlName(element, W_NS, 'style')) continue;
            const id = w(element, 'styleId') ?? '';
            const type = w(element, 'type') ?? 'paragraph';
            const firstRow = xmlElements(element).find(
                (child) => hasXmlName(child, W_NS, 'tblStylePr') && w(child, 'type') === 'firstRow',
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
        this.defaultParagraph =
            defaultParagraph ?? (this.byId.get('Normal')?.type === 'paragraph' ? 'Normal' : undefined);
    }

    public get(id: string | undefined): Style | undefined {
        return id === undefined ? undefined : this.byId.get(id);
    }

    // Its chain, nearest first, ends at MAX_CHAIN or at the first repeat of a cycle.
    private resolve(id: string | undefined): Resolved {
        let resolved = this.resolved.get(id);
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
            table: {
                fill: chain.find((style) => style.fill !== undefined)?.fill,
                firstRowRun: mergeRun(...rootFirst.flatMap((style) => style.firstRowRun ?? [])),
                firstRowFill: chain.find((style) => style.firstRowFill !== undefined)?.firstRowFill,
            },
        };
        this.resolved.set(id, resolved);
        return resolved;
    }

    public run(id: string | undefined): DocxRunProps {
        return this.resolve(id).run;
    }

    public para(id: string | undefined): ParaProps {
        return this.resolve(id).para;
    }

    public role(id: string | undefined): Role | undefined {
        return this.resolve(id).role;
    }

    public isCodeCharacter(id: string | undefined): boolean {
        return this.resolve(id).code;
    }

    public table(id: string | undefined): TableLook {
        return this.resolve(id).table;
    }
}
