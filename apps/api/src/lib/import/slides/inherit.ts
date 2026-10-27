// What a slide takes from its layout, master and theme: placeholders matched down the chain, the theme's colors,
// fonts and style matrix, and the shapes the layout and master draw beneath the slide's own. The paint reader
// resolves a fill or a background through what it finds here.

import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlElements } from '../../core/xml';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { DEGREE, NO_DRAWING_THEME, readColorMap, readColorScheme } from '../../ooxml/drawingml';
import { A_NS, emu, isOn, P_NS } from '../../ooxml/ooxml';
import type { Part } from '../../ooxml/opc';
import { childOf, firstChildOf } from './lookup';
import type { PptxPackage } from './package';
import { fillIn } from './paint';

export type SlideTheme = {
    colors: DrawingTheme;
    fonts: { major: string; minor: string };
    // a:fmtScheme's style matrix, which p:style and a background's bgRef index into, and the theme part naming its
    // pictures.
    formats: StyleMatrix;
    part?: Part;
};

type StyleMatrix = { fills: XmlElement[]; backgrounds: XmlElement[]; lines: XmlElement[] };

// What a placeholder's type and idx match it by.
export type PlaceholderKey = { type: string | undefined; idx: string | undefined };

// A layout's or master's placeholder and what a slide's inherits from it.
export type Placeholder = PlaceholderKey & { properties: ShapeProperties };

// What a shape states that the next in its chain answers where it doesn't. A placeholder's are read once with its part:
// each lookup costs its element's children, and every slide shape that inherits it would look again.
export type ShapeProperties = {
    xfrm: Xfrm | undefined;
    // The preset's name or custGeom, and the a:prstGeom or a:custGeom that draws it.
    geometry: string | undefined;
    geom: XmlElement | undefined;
    fill: XmlElement | undefined;
    ln: XmlElement | undefined;
    style: XmlElement | undefined;
    // Its p:txBody's a:bodyPr and a:lstStyle.
    bodyPr: XmlElement | undefined;
    listStyle: XmlElement | undefined;
};

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
    // p:txStyles' p:titleStyle, p:bodyStyle and p:otherStyle.
    textStyles: { title: XmlElement | undefined; body: XmlElement | undefined; other: XmlElement | undefined };
};

type Layout = { part: Part; master: Master | undefined; placeholders: Placeholders; showMasterSp: boolean };

export type SlideInheritance = {
    slide: Part;
    layout: Layout | undefined;
    master: Master | undefined;
    theme: SlideTheme;
    // The presentation's p:defaultTextStyle.
    defaultTextStyle: XmlElement | undefined;
};

// Layouts and masters are parsed and read once per file, whichever slides share them.
export function createInheritance(pkg: PptxPackage): (slide: Part) => SlideInheritance {
    const defaultTextStyle = childOf(pkg.presentation.root, P_NS, 'defaultTextStyle');
    const masters = new Map<string, Master>();
    const layouts = new Map<string, Layout>();
    // One object for each master and color map: what a color element shows is kept for the colors it was resolved with.
    const palettes = new Map<string, DrawingTheme>();
    const masterOf = (part: Part): Master => {
        const known = masters.get(part.path);
        if (known) return known;
        const themePart = pkg.related(part, 'theme');
        const theme = themePart?.root;
        const elements = theme && childOf(theme, A_NS, 'themeElements');
        const fontOf = (slot: string) => {
            const font = elements && childOf(childOf(elements, A_NS, 'fontScheme') ?? elements, A_NS, slot);
            return (font && xmlAttr(childOf(font, A_NS, 'latin') ?? font, '', 'typeface')) ?? '';
        };
        const clrMap = childOf(part.root, P_NS, 'clrMap');
        const formats = elements && childOf(elements, A_NS, 'fmtScheme');
        const list = (name: string) => {
            const found = formats && childOf(formats, A_NS, name);
            return found ? xmlElements(found) : [];
        };
        const txStyles = childOf(part.root, P_NS, 'txStyles');
        const master: Master = {
            part,
            theme: {
                colors: { scheme: readColorScheme(theme), map: readColorMap(clrMap ?? part.root) },
                fonts: { major: fontOf('majorFont'), minor: fontOf('minorFont') },
                formats: {
                    fills: list('fillStyleLst'),
                    backgrounds: list('bgFillStyleLst'),
                    lines: list('lnStyleLst').filter((line) => line.ns === A_NS && line.local === 'ln'),
                },
                part: themePart,
            },
            placeholders: placeholdersOf(part.root),
            textStyles: {
                title: txStyles && childOf(txStyles, P_NS, 'titleStyle'),
                body: txStyles && childOf(txStyles, P_NS, 'bodyStyle'),
                other: txStyles && childOf(txStyles, P_NS, 'otherStyle'),
            },
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
            showMasterSp: showsMasterShapes(part.root),
        };
        layouts.set(part.path, layout);
        return layout;
    };
    return (slide) => {
        const layoutPart = pkg.related(slide, 'slideLayout');
        const layout = layoutPart && layoutOf(layoutPart);
        const master = layout?.master;
        const theme = master?.theme ?? NO_THEME;
        const override = childOf(childOf(slide.root, P_NS, 'clrMapOvr') ?? slide.root, A_NS, 'overrideClrMapping');
        const map = override && readColorMap(override);
        const key = `${master?.part.path} ${JSON.stringify([...(map ?? theme.colors.map)])}`;
        const colors = palettes.get(key) ?? (map ? { ...theme.colors, map } : theme.colors);
        palettes.set(key, colors);
        return { slide, layout, master, theme: { ...theme, colors }, defaultTextStyle };
    };
}

const NO_THEME: SlideTheme = {
    colors: NO_DRAWING_THEME,
    fonts: { major: '', minor: '' },
    formats: { fills: [], backgrounds: [], lines: [] },
};

function showsMasterShapes(root: XmlElement): boolean {
    return isOn(xmlAttr(root, '', 'showMasterSp')) ?? true;
}

export function spTreeOf(root: XmlElement): XmlElement | undefined {
    const cSld = childOf(root, P_NS, 'cSld');
    return cSld && childOf(cSld, P_NS, 'spTree');
}

// p:nvSpPr, p:nvPicPr, p:nvGrpSpPr…: whichever non-visual properties the shape's kind has.
export function nonVisualOf(shape: XmlElement): XmlElement | undefined {
    return firstChildOf(shape, isNonVisual);
}

function isNonVisual(child: XmlElement): boolean {
    return child.ns === P_NS && child.local.startsWith('nv');
}

export function placeholderOf(shape: XmlElement): PlaceholderKey | undefined {
    const nv = nonVisualOf(shape);
    const nvPr = nv && childOf(nv, P_NS, 'nvPr');
    const ph = nvPr && childOf(nvPr, P_NS, 'ph');
    return ph && { type: xmlAttr(ph, '', 'type'), idx: xmlAttr(ph, '', 'idx') };
}

export function propertiesOf(shape: XmlElement): ShapeProperties {
    const spPr = childOf(shape, P_NS, 'spPr');
    const body = childOf(shape, P_NS, 'txBody');
    const preset = spPr && childOf(spPr, A_NS, 'prstGeom');
    const custom = !preset && spPr ? childOf(spPr, A_NS, 'custGeom') : undefined;
    return {
        // spPr's a:xfrm, or a graphic frame's own p:xfrm.
        xfrm: readXfrm(spPr ? childOf(spPr, A_NS, 'xfrm') : childOf(shape, P_NS, 'xfrm')),
        geometry: preset ? xmlAttr(preset, '', 'prst') : custom && 'custGeom',
        geom: preset ?? custom,
        fill: fillIn(spPr),
        ln: spPr && childOf(spPr, A_NS, 'ln'),
        style: childOf(shape, P_NS, 'style'),
        bodyPr: body && childOf(body, A_NS, 'bodyPr'),
        listStyle: body && childOf(body, A_NS, 'lstStyle'),
    };
}

export type Xfrm = {
    x: number;
    y: number;
    cx: number;
    cy: number;
    rot: number;
    flipH: boolean;
    flipV: boolean;
    child?: { x: number; y: number; cx: number; cy: number };
};

function point(element: XmlElement | undefined, x: string, y: string) {
    const [px, py] = [emu(element && xmlAttr(element, '', x)), emu(element && xmlAttr(element, '', y))];
    return px === undefined || py === undefined ? undefined : { x: px, y: py };
}

export function readXfrm(xfrm: XmlElement | undefined): Xfrm | undefined {
    const off = xfrm && point(childOf(xfrm, A_NS, 'off'), 'x', 'y');
    const ext = xfrm && point(childOf(xfrm, A_NS, 'ext'), 'cx', 'cy');
    if (!xfrm || !off || !ext) return undefined;
    const chOff = point(childOf(xfrm, A_NS, 'chOff'), 'x', 'y');
    const chExt = point(childOf(xfrm, A_NS, 'chExt'), 'cx', 'cy');
    const rot = Number(xmlAttr(xfrm, '', 'rot') ?? 0) / DEGREE;
    return {
        ...off,
        // A negative extent is no extent.
        cx: Math.max(0, ext.x),
        cy: Math.max(0, ext.y),
        rot: Number.isFinite(rot) ? rot : 0,
        flipH: isOn(xmlAttr(xfrm, '', 'flipH')) ?? false,
        flipV: isOn(xmlAttr(xfrm, '', 'flipV')) ?? false,
        child: chOff && chExt && { ...chOff, cx: chExt.x, cy: chExt.y },
    };
}

function placeholdersOf(root: XmlElement): Placeholders {
    const placeholders: Placeholders = { byIdx: new Map(), byType: new Map(), byKind: new Map() };
    const first = <K>(map: Map<K, Placeholder>, key: K, placeholder: Placeholder) => {
        if (!map.has(key)) map.set(key, placeholder);
    };
    const tree = spTreeOf(root);
    for (const shape of tree ? xmlElements(tree) : []) {
        const key = placeholderOf(shape);
        if (!key) continue;
        const placeholder = { ...key, properties: propertiesOf(shape) };
        if (placeholder.idx !== undefined) first(placeholders.byIdx, placeholder.idx, placeholder);
        first(placeholders.byType, placeholder.type, placeholder);
        first(placeholders.byKind, placeholderKind(placeholder.type), placeholder);
    }
    return placeholders;
}

// ctrTitle is a title; subTitle, obj, an untyped placeholder and one for content a master has no
// placeholder of its own for are body, as python-pptx matches them.
const BODY_TYPES = new Set(['body', 'subTitle', 'obj', 'pic', 'tbl', 'chart', 'clipArt', 'dgm', 'media']);

export function placeholderKind(type: string | undefined): string {
    if (type === 'ctrTitle' || type === 'title') return 'title';
    return type === undefined || BODY_TYPES.has(type) ? 'body' : type;
}

// The layout's and the master's placeholder a slide's own inherits from, nearest first. A layout matches by idx, then
// by type; a master by kind alone, as its dt, ftr and sldNum carry the idx 2 to 4 that layouts reuse for body text.
export function inheritedPlaceholders(own: PlaceholderKey, inheritance: SlideInheritance): Placeholder[] {
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
export function listStyleOf(own: PlaceholderKey | undefined, inheritance: SlideInheritance): XmlElement | undefined {
    if (!own) return inheritance.defaultTextStyle;
    const styles = inheritance.master?.textStyles;
    const kind = placeholderKind(own.type);
    return styles && (kind === 'title' ? styles.title : kind === 'body' ? styles.body : styles.other);
}

// The shape lists drawn beneath a slide's own, bottom first: the master's, then the layout's, as showMasterSp allows.
export function decorationsOf(inheritance: SlideInheritance): Part[] {
    const { slide, layout, master } = inheritance;
    if (!layout || !showsMasterShapes(slide.root)) return [];
    return master && layout.showMasterSp ? [master.part, layout.part] : [layout.part];
}
