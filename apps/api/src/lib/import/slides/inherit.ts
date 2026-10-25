import type { BackgroundFill, FillPaint } from '@workspace/lib/types/background';
import { normalizeAngle, SLIDES_STYLE_DEFAULTS, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlElements } from '../../core/xml';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { DEGREE, drawingColor, NO_DRAWING_THEME, percent, readColorMap, readColorScheme } from '../../ooxml/drawingml';
import { A_NS, emu, isOn, P_NS } from '../../ooxml/ooxml';
import type { Part } from '../../ooxml/opc';
import { cachedBy, charge, childOf, childrenOf, firstChildOf } from './lookup';
import type { DeckWalk, Lost, PptxPackage } from './package';
import { blipMedia } from './package';

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
    // One object for each master and colour map: what a colour element shows is kept for the colours it was resolved with.
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

function shows(root: XmlElement): boolean {
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
    return parent && firstChildOf(parent, isFill);
}

function isFill(child: XmlElement): boolean {
    return child.ns === A_NS && FILLS.has(child.local);
}

// EG_ColorChoice: the colour elements drawingColor takes the first of.
const COLOR_CHOICES = new Set(['scrgbClr', 'srgbClr', 'hslClr', 'sysClr', 'schemeClr', 'prstClr']);

function isColorChoice(child: XmlElement): boolean {
    return child.ns === A_NS && COLOR_CHOICES.has(child.local);
}

// A colour element reduced to what drawingColor reads: its colour child with the transforms it applies, and whether
// that colour is phClr.
type Swatch = { fill: XmlElement; transforms: number; placeholder: boolean };

const swatches = cachedBy<null, Swatch | undefined>();

// Found once, whatever colours it is resolved with: junk beside the colour or among its transforms is passed over once,
// not again for every phClr a style reference paints it with.
function swatchOf(element: XmlElement): Swatch | undefined {
    return swatches(element, null, () => {
        const color = firstChildOf(element, isColorChoice);
        if (!color) return undefined;
        charge(color.children.length);
        const transforms = xmlElements(color).filter(
            (transform) => transform.ns === A_NS && percent(xmlAttr(transform, '', 'val')) !== undefined,
        );
        return {
            fill: { ...element, children: [{ ...color, children: transforms }] },
            transforms: transforms.length,
            placeholder: color.local === 'schemeClr' && xmlAttr(color, '', 'val') === 'phClr',
        };
    });
}

const resolved = cachedBy<DrawingTheme, string | undefined>();

// What a colour element shows, resolved once for each slide's colours, and a phClr once for each phClr: one in a theme,
// master or layout is painted again for every shape and run that takes it.
export function colorOf(element: XmlElement | undefined, colors: DrawingTheme): string | undefined {
    const swatch = element && swatchOf(element);
    if (!element || !swatch) return undefined;
    const palette = swatch.placeholder ? colors : (unplaced.get(colors) ?? colors);
    return resolved(element, palette, () => {
        charge(1 + swatch.transforms);
        return drawingColor(swatch.fill, palette);
    });
}

// The slide's tx1, light on a dark theme: what an imported chart and a dropped object's box write in where the file
// states no colour.
export function textColorOf(colors: DrawingTheme): string {
    const slot = colors.map.get('tx1');
    return (slot && colors.scheme.get(slot)) ?? SLIDES_STYLE_DEFAULTS.color;
}

// Their axes and outlines: the text's colour faded, as PowerPoint's chart axes are.
export function mutedColor(color: string): string {
    return `${color.slice(0, 7)}99`;
}

const placeholderColors = new WeakMap<DrawingTheme, Map<string | undefined, DrawingTheme>>();
// Each phClr's colours back to the slide's, which any colour but phClr resolves the same with.
const unplaced = new WeakMap<DrawingTheme, DrawingTheme>();

// A slide's colours with a reference's phClr, one object for each, as colorOf keeps its answers by the object.
function withPlaceholder(colors: DrawingTheme, phClr: string | undefined): DrawingTheme {
    let known = placeholderColors.get(colors);
    if (!known) {
        known = new Map();
        placeholderColors.set(colors, known);
    }
    const found = known.get(phClr) ?? { ...colors, phClr };
    known.set(phClr, found);
    unplaced.set(found, colors);
    return found;
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
    const colors = reference ? withPlaceholder(theme.colors, colorOf(reference, theme.colors)) : theme.colors;
    const solid = (color: string | undefined): FillPaint | undefined => (color ? { type: 'solid', color } : undefined);
    switch (fill.local) {
        case 'solidFill':
            return solid(colorOf(fill, colors));
        case 'gradFill':
            return gradientOf(fill, colors, options);
        case 'pattFill':
            lost('fills-simplified');
            return solid(colorOf(childOf(fill, A_NS, 'fgClr'), colors));
        case 'grpFill':
            return options.group?.(lost) ?? TRANSPARENT_PAINT;
        case 'blipFill':
            lost('images-dropped');
            return TRANSPARENT_PAINT;
        default:
            return TRANSPARENT_PAINT;
    }
}

const TRANSPARENT_PAINT: FillPaint = { type: 'solid', color: TRANSPARENT_COLOR };

// The stops at the ramp's two ends, as PowerPoint orders them by position; Eigen draws the ramp between them in OKLab.
// A path gradient keeps its stops along DrawingML's default angle.
function gradientOf(fill: XmlElement, colors: DrawingTheme, options: PaintOptions): FillPaint | undefined {
    const { from, to, single } = rampOf(fill, colors);
    if (!from || !to) return undefined;
    if (single) return { type: 'solid', color: from };
    const lin = childOf(fill, A_NS, 'lin');
    if (!lin && childOf(fill, A_NS, 'path')) options.lost('fills-simplified');
    const ang = Number((lin && xmlAttr(lin, '', 'ang')) ?? 0) / DEGREE;
    const scaled = (lin && isOn(xmlAttr(lin, '', 'scaled'))) ?? false;
    const angle = (options.angle ?? quarterTurn)(Number.isFinite(ang) ? ang : 0, scaled);
    return { type: 'gradient', from, to, angle: normalizeAngle(Math.round(angle * 1000) / 1000) };
}

const stopLists = cachedBy<null, XmlElement[]>();

// A gradient's stops as PowerPoint orders them, by position, sorted once whatever colours paint them.
function stopsOf(fill: XmlElement): XmlElement[] {
    return stopLists(fill, null, () => {
        const list = childOf(fill, A_NS, 'gsLst');
        const stops = (list ? childrenOf(list, A_NS, 'gs') : []).map((stop) => {
            const at = Number(xmlAttr(stop, '', 'pos'));
            return { stop, at: Number.isFinite(at) ? at : 0 };
        });
        charge(stops.length);
        return stops.sort((a, b) => a.at - b.at).map(({ stop }) => stop);
    });
}

const ramps = cachedBy<DrawingTheme, { from: string | undefined; to: string | undefined; single: boolean }>();

// A gradient's end stops that show a colour, picked once for each slide's colours and phClr however many shapes it
// paints; a stop that shows none is passed over.
function rampOf(fill: XmlElement, colors: DrawingTheme) {
    return ramps(fill, colors, () => {
        const stops = stopsOf(fill);
        const shows = (stop: XmlElement) => {
            charge(1);
            return colorOf(stop, colors) !== undefined;
        };
        const first = stops.findIndex(shows);
        const last = first < 0 ? -1 : stops.findLastIndex(shows);
        return { from: colorOf(stops[first], colors), to: colorOf(stops[last], colors), single: first === last };
    });
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
        const cSld = part && childOf(part.root, P_NS, 'cSld');
        const bg = cSld && childOf(cSld, P_NS, 'bg');
        if (!bg) continue;
        const lost: Lost = (code) => deck.lost(code, bg);
        const bgPr = childOf(bg, P_NS, 'bgPr');
        const reference = bgPr ? undefined : childOf(bg, P_NS, 'bgRef');
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

function isEffect(child: XmlElement): boolean {
    return child.ns === A_NS && child.local !== 'extLst';
}

// A picture covers the frame, stretched or tiled. A tile is drawn as one picture, and a recolouring (a theme's duotone,
// a washout's lum) as the picture itself: each a loss counted.
function pictureBackground(blipFill: XmlElement, owner: Part, deck: DeckWalk, lost: Lost): BackgroundFill | null {
    const blip = childOf(blipFill, A_NS, 'blip');
    const media = blipMedia(deck.pkg, owner, blip);
    const mediaName = media && deck.mediaName(media);
    if (!blip || !mediaName) {
        if (blip) lost('images-dropped');
        return null;
    }
    if (firstChildOf(blip, isEffect) || childOf(blipFill, A_NS, 'tile')) lost('fills-simplified');
    return { type: 'image', mediaName, fit: 'cover' };
}
