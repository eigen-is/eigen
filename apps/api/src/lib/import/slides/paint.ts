// The pptx reader's paint: a fill, a line or a background resolved through the slide's color map and theme into a
// color, a gradient or a picture, as the canvas stores it. Each resolved color, ramp and stop list is kept per
// element, so a master's fill shows on every slide for the cost of one. Readers such as the shape and text readers
// paint through it.

import type { BackgroundFill, FillPaint } from '@workspace/lib/types/background';
import { DEG_TO_RAD, normalizeAngle, SLIDES_STYLE_DEFAULTS, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlElements } from '../../core/xml';
import type { Lost } from '../../document/transform/protocol';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { DEGREE, drawingColor, isColorChoice, percent } from '../../ooxml/drawingml';
import { A_NS, isOn, P_NS } from '../../ooxml/ooxml';
import type { Part } from '../../ooxml/opc';
import type { SlideInheritance, SlideTheme } from './inherit';
import { cachedBy, charge, childOf, childrenOf, firstChildOf } from './lookup';
import type { DeckWalk } from './package';
import { blipMedia } from './package';

const FILLS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);

// The fill element of spPr, a:ln or bgPr; undefined when it states none, so the next in its chain answers.
export function fillIn(parent: XmlElement | undefined): XmlElement | undefined {
    return parent && firstChildOf(parent, isFill);
}

function isFill(child: XmlElement): boolean {
    return child.ns === A_NS && FILLS.has(child.local);
}

// A color element reduced to what drawingColor reads: its color child with the transforms it applies, and whether
// that color is phClr.
type Swatch = { fill: XmlElement; transforms: number; placeholder: boolean };

const swatches = cachedBy<null, Swatch | undefined>();

// Found once, whatever colors it is resolved with: junk beside the color or among its transforms is passed over once,
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

// What a color element shows, resolved once for each slide's colors, and a phClr once for each phClr: one in a theme,
// master or layout is painted again for every shape and run that takes it.
export function resolvedColor(element: XmlElement | undefined, colors: DrawingTheme): string | undefined {
    const swatch = element && swatchOf(element);
    if (!element || !swatch) return undefined;
    const palette = swatch.placeholder ? colors : (unplaced.get(colors) ?? colors);
    return resolved(element, palette, () => {
        charge(1 + swatch.transforms);
        return drawingColor(swatch.fill, palette);
    });
}

// The slide's tx1, light on a dark theme: what an imported chart and a dropped object's box write in where the file
// states no color.
export function textColorOf(colors: DrawingTheme): string {
    const slot = colors.map.get('tx1');
    return (slot && colors.scheme.get(slot)) ?? SLIDES_STYLE_DEFAULTS.color;
}

// A text color at 60% opacity, for the dashed outline of the box that marks a dropped object.
export function mutedColor(color: string): string {
    return `${color.slice(0, 7)}99`;
}

const placeholderColors = new WeakMap<DrawingTheme, Map<string | undefined, DrawingTheme>>();
// Maps each slide's colors with a phClr back to the slide's own colors. A color other than phClr resolves the same
// through either, so resolvedColor caches it once, under the slide's colors.
const unplaced = new WeakMap<DrawingTheme, DrawingTheme>();

// A slide's colors with a reference's phClr, one object for each, as resolvedColor keeps its answers by the object.
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
    // The fillRef, lnRef or bgRef whose color a style matrix entry's phClr shows.
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
    const colors = reference ? withPlaceholder(theme.colors, resolvedColor(reference, theme.colors)) : theme.colors;
    const solid = (color: string | undefined): FillPaint | undefined => (color ? { type: 'solid', color } : undefined);
    switch (fill.local) {
        case 'solidFill':
            return solid(resolvedColor(fill, colors));
        case 'gradFill':
            return gradientOf(fill, colors, options);
        case 'pattFill':
            lost('fills-simplified');
            return solid(resolvedColor(childOf(fill, A_NS, 'fgClr'), colors));
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

// A gradient's stops as PowerPoint orders them, by position, sorted once whatever colors paint them.
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

// A gradient's end stops that show a color, picked once for each slide's colors and phClr however many shapes it
// paints; a stop that shows none is passed over.
function rampOf(fill: XmlElement, colors: DrawingTheme) {
    return ramps(fill, colors, () => {
        const stops = stopsOf(fill);
        const shows = (stop: XmlElement) => {
            charge(1);
            return resolvedColor(stop, colors) !== undefined;
        };
        const first = stops.findIndex(shows);
        const last = first < 0 ? -1 : stops.findLastIndex(shows);
        return {
            from: resolvedColor(stops[first], colors),
            to: resolvedColor(stops[last], colors),
            single: first === last,
        };
    });
}

// DrawingML's angle runs from left-to-right, the canvas's and CSS's from bottom-to-top.
function quarterTurn(degrees: number): number {
    return degrees + 90;
}

// An element's gradient, which the canvas lays along its box's units (objectBoundingBox): a scaled angle is already in
// them, a true one is the box-unit angle whose isolines the box stretches onto the true ones.
export function elementGradientAngle(width: number, height: number): GradientAngle {
    return (degrees, scaled) => {
        if (scaled) return quarterTurn(degrees);
        const r = degrees * DEG_TO_RAD;
        return Math.atan2(width * Math.cos(r), -height * Math.sin(r)) / DEG_TO_RAD;
    };
}

// A background's gradient, which CSS draws at a true angle: a scaled one turns with the slide's proportions.
function backgroundGradientAngle(width: number, height: number): GradientAngle {
    return (degrees, scaled) => {
        if (!scaled) return quarterTurn(degrees);
        const r = degrees * DEG_TO_RAD;
        return quarterTurn(Math.atan2(width * Math.sin(r), height * Math.cos(r)) / DEG_TO_RAD);
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

// A picture covers the frame, stretched or tiled. A tile is drawn as one picture, and a recoloring (a theme's duotone,
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
