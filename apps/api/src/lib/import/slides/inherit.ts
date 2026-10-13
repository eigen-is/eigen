import type { BackgroundFill, FillPaint } from '@workspace/lib/types/background';
import { normalizeAngle, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import {
    type DrawingTheme,
    drawingColor,
    IDENTITY_COLOR_MAP,
    readColorMap,
    readColorScheme,
} from '../../core/drawingml';
import { A_NS, isOn, P_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../core/xml';
import { blipMedia, type DeckWalk, emu, type Lost, type Part, type PptxPackage } from './package';

// What a slide takes from its layout, master and theme (SPEC X-D4): placeholders matched down the chain, the colour
// map, the background, and the shapes the layout and master draw beneath the slide's own.

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
    // The preset's or custGeom's name, and the a:prstGeom a pie's angles are in.
    geometry: string | undefined;
    preset: XmlElement | undefined;
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
    const defaultTextStyle = xmlChild(pkg.presentation.root, P_NS, 'defaultTextStyle');
    const masters = new Map<string, Master>();
    const layouts = new Map<string, Layout>();
    const masterOf = (part: Part): Master => {
        const known = masters.get(part.path);
        if (known) return known;
        const themePart = pkg.related(part, 'theme');
        const theme = themePart?.root;
        const elements = theme && xmlChild(theme, A_NS, 'themeElements');
        const fontOf = (slot: string) => {
            const font = elements && xmlChild(xmlChild(elements, A_NS, 'fontScheme') ?? elements, A_NS, slot);
            return (font && xmlAttr(xmlChild(font, A_NS, 'latin') ?? font, '', 'typeface')) ?? '';
        };
        const clrMap = xmlChild(part.root, P_NS, 'clrMap');
        const formats = elements && xmlChild(elements, A_NS, 'fmtScheme');
        const list = (name: string) => {
            const found = formats && xmlChild(formats, A_NS, name);
            return found ? xmlElements(found) : [];
        };
        const txStyles = xmlChild(part.root, P_NS, 'txStyles');
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
                title: txStyles && xmlChild(txStyles, P_NS, 'titleStyle'),
                body: txStyles && xmlChild(txStyles, P_NS, 'bodyStyle'),
                other: txStyles && xmlChild(txStyles, P_NS, 'otherStyle'),
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
        return { slide, layout, master, theme: { ...theme, colors }, defaultTextStyle };
    };
}

const NO_THEME: SlideTheme = {
    colors: { scheme: new Map(), map: IDENTITY_COLOR_MAP },
    fonts: { major: '', minor: '' },
    formats: { fills: [], backgrounds: [], lines: [] },
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

export function placeholderOf(shape: XmlElement): PlaceholderKey | undefined {
    const nv = nonVisualOf(shape);
    const nvPr = nv && xmlChild(nv, P_NS, 'nvPr');
    const ph = nvPr && xmlChild(nvPr, P_NS, 'ph');
    return ph && { type: xmlAttr(ph, '', 'type'), idx: xmlAttr(ph, '', 'idx') };
}

export function propertiesOf(shape: XmlElement): ShapeProperties {
    const spPr = xmlChild(shape, P_NS, 'spPr');
    const body = xmlChild(shape, P_NS, 'txBody');
    const preset = spPr && xmlChild(spPr, A_NS, 'prstGeom');
    return {
        // spPr's a:xfrm, or a graphic frame's own p:xfrm.
        xfrm: readXfrm(spPr ? xmlChild(spPr, A_NS, 'xfrm') : xmlChild(shape, P_NS, 'xfrm')),
        geometry: preset
            ? xmlAttr(preset, '', 'prst')
            : spPr && xmlChild(spPr, A_NS, 'custGeom')
              ? 'custGeom'
              : undefined,
        preset,
        fill: fillIn(spPr),
        ln: spPr && xmlChild(spPr, A_NS, 'ln'),
        style: xmlChild(shape, P_NS, 'style'),
        bodyPr: body && xmlChild(body, A_NS, 'bodyPr'),
        listStyle: body && xmlChild(body, A_NS, 'lstStyle'),
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
    const off = xfrm && point(xmlChild(xfrm, A_NS, 'off'), 'x', 'y');
    const ext = xfrm && point(xmlChild(xfrm, A_NS, 'ext'), 'cx', 'cy');
    if (!xfrm || !off || !ext) return undefined;
    const chOff = point(xmlChild(xfrm, A_NS, 'chOff'), 'x', 'y');
    const chExt = point(xmlChild(xfrm, A_NS, 'chExt'), 'cx', 'cy');
    const rot = Number(xmlAttr(xfrm, '', 'rot') ?? 0) / 60_000;
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

// SPEC X-D4: ctrTitle is a title; subTitle, obj, an untyped placeholder and one for content a master has no
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
    if (!layout || !shows(slide.root)) return [];
    return master && layout.showMasterSp ? [master.part, layout.part] : [layout.part];
}

// ── Colour ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FILLS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);

// The fill element of spPr, a:ln or bgPr; undefined when it states none, so the next in its chain answers.
export function fillIn(parent: XmlElement | undefined): XmlElement | undefined {
    return parent && xmlElements(parent).find((child) => child.ns === A_NS && FILLS.has(child.local));
}

export type PaintOptions = {
    // A fill drawn simpler than the file has it, or a picture fill dropped.
    lost: Lost;
    // The fillRef, lnRef or bgRef whose colour a style matrix entry's phClr shows.
    reference?: XmlElement;
    // What grpFill shows.
    group?: GroupFill;
    // An a:lin angle as the stored one; on a square box, a quarter turn on.
    angle?: GradientAngle;
};

// The enclosing group's fill, painted only when a child shows it, so a loss in it counts only then.
export type GroupFill = (lost: Lost) => FillPaint | undefined;

// DrawingML's a:lin angle, clockwise from left-to-right in degrees, and whether it scales with the box.
export type GradientAngle = (degrees: number, scaled: boolean) => number;

// The one place a fill element (a shape's, a line's, a background's, a style matrix entry) becomes paint.
export function paintOf(fill: XmlElement | undefined, theme: SlideTheme, options: PaintOptions): FillPaint | undefined {
    if (!fill) return undefined;
    const { reference, lost } = options;
    const colors = reference ? { ...theme.colors, phClr: drawingColor(reference, theme.colors) } : theme.colors;
    const solid = (color: string | undefined): FillPaint | undefined => (color ? { type: 'solid', color } : undefined);
    switch (fill.local) {
        case 'solidFill':
            return solid(drawingColor(fill, colors));
        case 'gradFill':
            return gradientOf(fill, colors, options);
        case 'pattFill':
            lost('fills-simplified');
            return solid(drawingColor(xmlChild(fill, A_NS, 'fgClr'), colors));
        case 'grpFill':
            return options.group?.(lost) ?? TRANSPARENT_PAINT;
        case 'blipFill':
            lost('images-unshown');
            return TRANSPARENT_PAINT;
        default:
            return TRANSPARENT_PAINT;
    }
}

const TRANSPARENT_PAINT: FillPaint = { type: 'solid', color: TRANSPARENT_COLOR };

// The stops at the ramp's two ends, as PowerPoint orders them by position; Eigen draws the ramp between them in OKLab.
// A path gradient keeps its stops along DrawingML's default angle.
function gradientOf(fill: XmlElement, colors: DrawingTheme, options: PaintOptions): FillPaint | undefined {
    const list = xmlChild(fill, A_NS, 'gsLst');
    const stops = (list ? xmlChildren(list, A_NS, 'gs') : [])
        .map((stop) => ({ at: Number(xmlAttr(stop, '', 'pos')), color: drawingColor(stop, colors) }))
        .filter((stop) => stop.color !== undefined);
    stops.sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0));
    const [from, to] = [stops[0]?.color, stops.at(-1)?.color];
    if (!from || !to) return undefined;
    if (stops.length === 1) return { type: 'solid', color: from };
    const lin = xmlChild(fill, A_NS, 'lin');
    if (!lin && xmlChild(fill, A_NS, 'path')) options.lost('fills-simplified');
    const ang = Number((lin && xmlAttr(lin, '', 'ang')) ?? 0) / 60_000;
    const scaled = (lin && isOn(xmlAttr(lin, '', 'scaled'))) ?? false;
    const angle = (options.angle ?? quarterTurn)(Number.isFinite(ang) ? ang : 0, scaled);
    return { type: 'gradient', from, to, angle: normalizeAngle(Math.round(angle * 1000) / 1000) };
}

// DrawingML's angle runs from left-to-right, the canvas's and CSS's from bottom-to-top.
function quarterTurn(degrees: number): number {
    return degrees + 90;
}

const RADIANS = Math.PI / 180;

// An element's gradient, which the canvas lays along its box's units (objectBoundingBox): a scaled angle is already in
// them, a true one is the box-unit angle whose isolines the box stretches onto the true ones.
export function elementGradientAngle(width: number, height: number): GradientAngle {
    return (degrees, scaled) => {
        if (scaled) return quarterTurn(degrees);
        const r = degrees * RADIANS;
        return Math.atan2(width * Math.cos(r), -height * Math.sin(r)) / RADIANS;
    };
}

// A background's gradient, which CSS draws at a true angle: a scaled one turns with the slide's proportions.
export function backgroundGradientAngle(width: number, height: number): GradientAngle {
    return (degrees, scaled) => {
        if (!scaled) return quarterTurn(degrees);
        const r = degrees * RADIANS;
        return quarterTurn(Math.atan2(width * Math.sin(r), height * Math.cos(r)) / RADIANS);
    };
}

// A style matrix entry: a bgRef or fillRef idx of 1–999 picks from fillStyleLst, 1001 and up from bgFillStyleLst.
export function styleFill(theme: SlideTheme, idx: string | undefined): XmlElement | undefined {
    const index = Number(idx);
    if (!Number.isInteger(index) || index < 1) return undefined;
    return index >= 1001 ? theme.formats.backgrounds[index - 1001] : theme.formats.fills[index - 1];
}

// An lnRef's a:ln in lnStyleLst, idx 1 and up; 0 is no line.
export function styleLine(theme: SlideTheme, idx: string | undefined): XmlElement | undefined {
    const index = Number(idx);
    return Number.isInteger(index) && index >= 1 ? theme.formats.lines[index - 1] : undefined;
}

// The slide's p:bg, else its layout's, else its master's (88% of decks paint from the master).
export function backgroundOf(inheritance: SlideInheritance, deck: DeckWalk): BackgroundFill | null {
    const { slide, layout, master, theme } = inheritance;
    for (const part of [slide, layout?.part, master?.part]) {
        const cSld = part && xmlChild(part.root, P_NS, 'cSld');
        const bg = cSld && xmlChild(cSld, P_NS, 'bg');
        if (!bg) continue;
        const lost: Lost = (code) => deck.lost(code, bg);
        const bgPr = xmlChild(bg, P_NS, 'bgPr');
        const reference = bgPr ? undefined : xmlChild(bg, P_NS, 'bgRef');
        const fill = bgPr ? fillIn(bgPr) : styleFill(theme, reference && xmlAttr(reference, '', 'idx'));
        // A bgRef's picture is named by the theme's relationships.
        const owner = bgPr ? part : theme.part;
        if (fill?.local === 'blipFill') return owner ? pictureBackground(fill, owner, deck, lost) : null;
        const angle = backgroundGradientAngle(deck.slide.width, deck.slide.height);
        const paint = paintOf(fill, theme, { reference, angle, lost });
        return paint && !(paint.type === 'solid' && paint.color === TRANSPARENT_COLOR) ? paint : null;
    }
    return null;
}

// A picture covers the frame, stretched or tiled. A tile is drawn as one picture, and a recolouring (a theme's duotone,
// a washout's lum) as the picture itself: each a loss counted.
function pictureBackground(blipFill: XmlElement, owner: Part, deck: DeckWalk, lost: Lost): BackgroundFill | null {
    const blip = xmlChild(blipFill, A_NS, 'blip');
    const media = blipMedia(deck.pkg, owner, blip);
    if (!blip || !media) {
        if (blip) lost('images-unshown');
        return null;
    }
    const effects = xmlElements(blip).some((child) => child.ns === A_NS && child.local !== 'extLst');
    if (effects || xmlChild(blipFill, A_NS, 'tile')) lost('fills-simplified');
    return { type: 'image', mediaName: deck.mediaName(media), fit: 'cover' };
}
