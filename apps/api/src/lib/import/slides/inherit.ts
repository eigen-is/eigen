import type { BackgroundFill, FillPaint } from '@workspace/lib/types/background';
import { TRANSPARENT_COLOR } from '@workspace/lib/vector';
import {
    type DrawingTheme,
    drawingColor,
    IDENTITY_COLOR_MAP,
    readColorMap,
    readColorScheme,
} from '../../core/drawingml';
import { A_NS, isOn, P_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../core/xml';
import type { Part, PptxPackage } from './package';

// What a slide takes from its layout, master and theme (SPEC X-D4): placeholders matched down the chain, the colour
// map, the background, and the shapes the layout and master draw beneath the slide's own.

export type SlideTheme = {
    colors: DrawingTheme;
    fonts: { major: string; minor: string };
    // a:fmtScheme, the style matrix p:style and a background's bgRef index into.
    formats: XmlElement | undefined;
};

export type Placeholder = { type: string | undefined; idx: string | undefined; shape: XmlElement };

// A part's placeholders by idx, type and kind, read once with the part; the first of each wins.
type Placeholders = {
    byIdx: Map<string, Placeholder>;
    byType: Map<string | undefined, Placeholder>;
    byKind: Map<string, Placeholder>;
};

type Master = {
    part: Part;
    theme: SlideTheme;
    placeholders: Placeholders;
    txStyles: XmlElement | undefined;
};

type Layout = { part: Part; master: Master | undefined; placeholders: Placeholders; showMasterSp: boolean };

export type SlideInheritance = {
    slide: Part;
    layout: Layout | undefined;
    master: Master | undefined;
    theme: SlideTheme;
};

// Layouts and masters are parsed and read once per file, whichever slides share them.
export function createInheritance(pkg: PptxPackage): (slide: Part) => SlideInheritance {
    const masters = new Map<string, Master>();
    const layouts = new Map<string, Layout>();
    const masterOf = (part: Part): Master => {
        const known = masters.get(part.path);
        if (known) return known;
        const theme = pkg.related(part, 'theme')?.root;
        const elements = theme && xmlChild(theme, A_NS, 'themeElements');
        const fontOf = (slot: string) => {
            const font = elements && xmlChild(xmlChild(elements, A_NS, 'fontScheme') ?? elements, A_NS, slot);
            return (font && xmlAttr(xmlChild(font, A_NS, 'latin') ?? font, '', 'typeface')) ?? '';
        };
        const clrMap = xmlChild(part.root, P_NS, 'clrMap');
        const master: Master = {
            part,
            theme: {
                colors: { scheme: readColorScheme(theme), map: readColorMap(clrMap ?? part.root) },
                fonts: { major: fontOf('majorFont'), minor: fontOf('minorFont') },
                formats: elements && xmlChild(elements, A_NS, 'fmtScheme'),
            },
            placeholders: placeholdersOf(part.root),
            txStyles: xmlChild(part.root, P_NS, 'txStyles'),
        };
        masters.set(part.path, master);
        return master;
    };
    const layoutOf = (part: Part): Layout => {
        const known = layouts.get(part.path);
        if (known) return known;
        const master = pkg.related(part, 'slideMaster');
        const layout: Layout = {
            part,
            master: master && masterOf(master),
            placeholders: placeholdersOf(part.root),
            showMasterSp: shows(part.root),
        };
        layouts.set(part.path, layout);
        return layout;
    };
    return (slide) => {
        const layoutPart = pkg.related(slide, 'slideLayout');
        const layout = layoutPart && layoutOf(layoutPart);
        const master = layout?.master;
        const theme = master?.theme ?? NO_THEME;
        const override = xmlChild(xmlChild(slide.root, P_NS, 'clrMapOvr') ?? slide.root, A_NS, 'overrideClrMapping');
        const colors = override ? { ...theme.colors, map: readColorMap(override) } : theme.colors;
        return { slide, layout, master, theme: { ...theme, colors } };
    };
}

const NO_THEME: SlideTheme = {
    colors: { scheme: new Map(), map: IDENTITY_COLOR_MAP },
    fonts: { major: '', minor: '' },
    formats: undefined,
};

function shows(root: XmlElement): boolean {
    return isOn(xmlAttr(root, '', 'showMasterSp')) ?? true;
}

export function spTreeOf(root: XmlElement): XmlElement | undefined {
    const cSld = xmlChild(root, P_NS, 'cSld');
    return cSld && xmlChild(cSld, P_NS, 'spTree');
}

// p:nvSpPr, p:nvPicPr, p:nvGrpSpPr…: whichever non-visual properties the shape's kind has.
export function nonVisualOf(shape: XmlElement): XmlElement | undefined {
    return xmlElements(shape).find((child) => child.ns === P_NS && child.local.startsWith('nv'));
}

export function placeholderOf(shape: XmlElement): Placeholder | undefined {
    const nv = nonVisualOf(shape);
    const nvPr = nv && xmlChild(nv, P_NS, 'nvPr');
    const ph = nvPr && xmlChild(nvPr, P_NS, 'ph');
    return ph && { type: xmlAttr(ph, '', 'type'), idx: xmlAttr(ph, '', 'idx'), shape };
}

function placeholdersOf(root: XmlElement): Placeholders {
    const placeholders: Placeholders = { byIdx: new Map(), byType: new Map(), byKind: new Map() };
    const first = <K>(map: Map<K, Placeholder>, key: K, placeholder: Placeholder) => {
        if (!map.has(key)) map.set(key, placeholder);
    };
    const tree = spTreeOf(root);
    for (const shape of tree ? xmlElements(tree) : []) {
        const placeholder = placeholderOf(shape);
        if (!placeholder) continue;
        if (placeholder.idx !== undefined) first(placeholders.byIdx, placeholder.idx, placeholder);
        first(placeholders.byType, placeholder.type, placeholder);
        first(placeholders.byKind, placeholderKind(placeholder.type), placeholder);
    }
    return placeholders;
}

// SPEC X-D4: ctrTitle is a title; subTitle, obj, an untyped placeholder and one for content a master has no
// placeholder of its own for are body, as python-pptx matches them.
const BODY_TYPES = new Set(['body', 'subTitle', 'obj', 'pic', 'tbl', 'chart', 'clipArt', 'dgm', 'media']);

export function placeholderKind(type: string | undefined): string {
    if (type === 'ctrTitle' || type === 'title') return 'title';
    return type === undefined || BODY_TYPES.has(type) ? 'body' : type;
}

// The layout's and the master's placeholder a slide's own inherits from, nearest first. A layout matches by idx, then
// by type; a master by kind alone, as its dt, ftr and sldNum carry the idx 2 to 4 that layouts reuse for body text.
export function inheritedPlaceholders(own: Placeholder, inheritance: SlideInheritance): Placeholder[] {
    const layout = inheritance.layout?.placeholders;
    const fromLayout =
        layout &&
        ((own.idx !== undefined ? layout.byIdx.get(own.idx) : undefined) ??
            layout.byType.get(own.type) ??
            layout.byKind.get(placeholderKind(own.type)));
    const fromMaster = inheritance.master?.placeholders.byKind.get(placeholderKind((fromLayout ?? own).type));
    return [fromLayout, fromMaster].filter((placeholder) => placeholder !== undefined);
}

// The master's text style for a placeholder of this kind, or the presentation's default for any other shape.
export function listStyleOf(
    own: Placeholder | undefined,
    inheritance: SlideInheritance,
    presentation: Part,
): XmlElement | undefined {
    if (!own) return xmlChild(presentation.root, P_NS, 'defaultTextStyle');
    const styles = inheritance.master?.txStyles;
    const kind = placeholderKind(own.type);
    const name = kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle';
    return styles && xmlChild(styles, P_NS, name);
}

// The shape lists drawn beneath a slide's own, bottom first: the master's, then the layout's, as showMasterSp allows.
export function decorationsOf(inheritance: SlideInheritance): Part[] {
    const { slide, layout, master } = inheritance;
    if (!layout || !shows(slide.root)) return [];
    return master && layout.showMasterSp ? [master.part, layout.part] : [layout.part];
}

// ── Colour ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FILLS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);

// The fill element of spPr, a:ln or bgPr; undefined when it states none, so the next in its chain answers.
export function fillIn(parent: XmlElement | undefined): XmlElement | undefined {
    return parent && xmlElements(parent).find((child) => child.ns === A_NS && FILLS.has(child.local));
}

// The one place a fill element (a shape's, a line's, a background's, a style matrix entry) becomes paint. `phClr` is
// the colour a style reference supplies; `group` is what grpFill shows.
export function paintOf(
    fill: XmlElement | undefined,
    theme: SlideTheme,
    options: { phClr?: XmlElement; group?: FillPaint } = {},
): FillPaint | undefined {
    if (!fill) return undefined;
    const color = (element: XmlElement | undefined) =>
        drawingColor(element, theme.colors) ?? (options.phClr && drawingColor(options.phClr, theme.colors));
    switch (fill.local) {
        case 'solidFill': {
            const solid = color(fill);
            return solid ? { type: 'solid', color: solid } : undefined;
        }
        case 'gradFill': {
            // The first stop for now; the two-stop gradient is X4a-3's.
            const list = xmlChild(fill, A_NS, 'gsLst');
            const [stop] = list ? xmlChildren(list, A_NS, 'gs') : [];
            const first = color(stop);
            return first ? { type: 'solid', color: first } : undefined;
        }
        case 'grpFill':
            return options.group ?? TRANSPARENT_PAINT;
        default:
            // noFill, and a picture or pattern fill, which a shape can't paint.
            return TRANSPARENT_PAINT;
    }
}

const TRANSPARENT_PAINT: FillPaint = { type: 'solid', color: TRANSPARENT_COLOR };

// A style matrix entry: a bgRef or fillRef idx of 1–999 picks from fillStyleLst, 1001 and up from bgFillStyleLst.
export function styleFill(theme: SlideTheme, idx: string | undefined): XmlElement | undefined {
    const index = Number(idx);
    if (!theme.formats || !Number.isInteger(index) || index < 1) return undefined;
    const [list, at] = index >= 1001 ? ['bgFillStyleLst', index - 1001] : ['fillStyleLst', index - 1];
    const fills = xmlChild(theme.formats, A_NS, list);
    return fills && xmlElements(fills)[at];
}

// The slide's p:bg, else its layout's, else its master's (88% of decks paint from the master).
export function backgroundOf(inheritance: SlideInheritance): BackgroundFill | null {
    const { slide, layout, master, theme } = inheritance;
    for (const part of [slide, layout?.part, master?.part]) {
        const cSld = part && xmlChild(part.root, P_NS, 'cSld');
        const bg = cSld && xmlChild(cSld, P_NS, 'bg');
        if (!bg) continue;
        const bgPr = xmlChild(bg, P_NS, 'bgPr');
        const bgRef = xmlChild(bg, P_NS, 'bgRef');
        const paint = bgPr
            ? paintOf(fillIn(bgPr), theme)
            : bgRef && paintOf(styleFill(theme, xmlAttr(bgRef, '', 'idx')), theme, { phClr: bgRef });
        return paint && !(paint.type === 'solid' && paint.color === TRANSPARENT_COLOR) ? paint : null;
    }
    return null;
}
