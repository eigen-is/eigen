import { escapeHtml } from '@workspace/lib/html';
import type { FillPaint } from '@workspace/lib/types/background';
import {
    type Arrowhead,
    type NewVectorElement,
    normalizeAngle,
    SLIDES_STYLE_DEFAULTS,
    type StrokeStyle,
    type StyleDefaults,
    serializeFill,
    TRANSPARENT_COLOR,
    type VectorElementPatch,
} from '@workspace/lib/vector';
import { drawingLines } from '../../core/drawingml';
import { ApiError } from '../../core/errors';
import { A_NS, ASVG_NS, isAlternateContent, isOn, P_NS, R_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../core/xml';
import type { CountedWarningCode } from '../../document/transform/protocol';
import { POINTS_PER_UNIT } from '../doc/package';
import { PRESENTATION_TOO_LARGE } from '../messages';
import {
    decorationsOf,
    fillIn,
    inheritedPlaceholders,
    listStyleOf,
    nonVisualOf,
    type Placeholder,
    paintOf,
    placeholderKind,
    placeholderOf,
    type SlideInheritance,
    spTreeOf,
} from './inherit';
import { alternative, type MediaPart, type Part, type PptxPackage } from './package';
import { richTextOf } from './text';

// A slide's shape tree → canvas elements (SPEC X-D3, X-D5): groups flattened, layout and master shapes beneath.

export const MAX_ELEMENTS = 20_000;
export const MAX_GROUP_DEPTH = 32;

// An element is a Y.Map of about twenty fields, and a string costs per character besides: the weight caps both before
// the update is built, and so the update the main thread reads back. The corpus's heaviest weighs 3,307 (a 2.4 MB
// update); at the cap a text-heavy update is about 25 MB and commits in 135 ms.
export const MAX_PPTX_WEIGHT = 50_000;
const CHARS_PER_UNIT = 512;

// How an imported element looks where the file says nothing: crisp, unframed, unfilled, never the editor's rounding.
export const PPTX_STYLE: StyleDefaults = {
    ...SLIDES_STYLE_DEFAULTS,
    strokeColor: TRANSPARENT_COLOR,
    corners: 'straight',
    roughness: 0,
};

// What a dropped object leaves on the slide in its place, and the warning that counts it.
const DROPPED = {
    table: { label: 'Table not imported', code: 'tables-dropped' },
    chart: { label: 'Chart not imported', code: 'charts-dropped' },
    diagram: { label: 'SmartArt not imported', code: 'diagrams-dropped' },
    ole: { label: 'Embedded object not imported', code: 'objects-dropped' },
    object: { label: 'Object not imported', code: 'objects-dropped' },
    picture: { label: 'Picture not imported', code: 'images-unshown' },
} satisfies Record<string, { label: string; code: CountedWarningCode }>;
type Dropped = keyof typeof DROPPED;

const GRAPHIC_KINDS = new Map<string, Dropped>([
    ['http://schemas.openxmlformats.org/drawingml/2006/table', 'table'],
    ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart'],
    ['http://schemas.microsoft.com/office/drawing/2014/chartex', 'chart'],
    ['http://schemas.openxmlformats.org/drawingml/2006/diagram', 'diagram'],
    ['http://schemas.openxmlformats.org/presentationml/2006/ole', 'ole'],
]);

const PLACEHOLDER_BOX = { fill: '#f1f3f4', stroke: '#9aa0a6', text: '#5f6368' };

// A head or tail end of a:ln as the arrowhead that draws closest.
const ARROWHEADS = new Map<string, Arrowhead>([
    ['triangle', 'triangle'],
    ['stealth', 'triangle'],
    ['arrow', 'arrow'],
    ['oval', 'circle'],
    ['diamond', 'circle'],
]);

// PowerPoint's line when a:ln states no width: 0.75 pt.
const DEFAULT_LINE_EMU = 9525;

export type Frame = { width: number; height: number };

// What a walk over one deck shares: its budget, its pictures, its losses.
export type DeckWalk = {
    pkg: PptxPackage;
    // The frame's size, its px per EMU, and where the slide's origin lands in it.
    frame: Frame;
    scale: number;
    offset: { x: number; y: number };
    // Children walked and elements written, each capped: a master's shapes are walked again for every slide.
    shapes: number;
    elements: number;
    // The update's weight so far, charged as each frame and element is written.
    weight: number;
    // A picture part's media name, the first time a slide shows it.
    mediaName(part: MediaPart): string;
    dropped: Map<CountedWarningCode, number>;
};

export type SlideShapes = { elements: NewVectorElement[]; title: string };

// x' = a·x + c·y, y' = b·x + d·y: a turn after the flips, as DrawingML applies them about a box's centre.
type Turn = [a: number, b: number, c: number, d: number];

function apply(m: Turn, x: number, y: number): { x: number; y: number } {
    return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

// `rot` degrees clockwise (y down) after the flips.
function turn(rot: number, flipH: boolean, flipV: boolean): Turn {
    const r = (rot * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const [h, v] = [flipH ? -1 : 1, flipV ? -1 : 1];
    return [cos * h, sin * h, -sin * v, cos * v];
}

type Xfrm = {
    x: number;
    y: number;
    cx: number;
    cy: number;
    rot: number;
    flipH: boolean;
    flipV: boolean;
    child?: { x: number; y: number; cx: number; cy: number };
};

// ST_Coordinate in EMU, or Strict's universal measure; anything else, or past what a double holds exactly, is none.
function emu(value: string | undefined): number | undefined {
    const [, number, unit = ''] = value?.trim().match(/^(-?\d+(?:\.\d+)?)([a-z]*)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    const result = unit === '' ? Number(number) : points === undefined ? Number.NaN : Number(number) * points * 12_700;
    return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined;
}

function point(element: XmlElement | undefined, x: string, y: string) {
    const [px, py] = [emu(element && xmlAttr(element, '', x)), emu(element && xmlAttr(element, '', y))];
    return px === undefined || py === undefined ? undefined : { x: px, y: py };
}

function readXfrm(xfrm: XmlElement | undefined): Xfrm | undefined {
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

// A shape as DrawingML places it: its centre, extents, turn and flips.
type Placement = { x: number; y: number; width: number; height: number; rot: number; flipH: boolean; flipV: boolean };

// From a shape tree's coordinates, in EMU, to the frame's px: through each enclosing group, then the slide's scale.
type Place = (shape: Placement) => Placement;

// A group lays its children out in its chOff/chExt space, scaled onto its off/ext, then flips and turns them about its
// centre. As PowerPoint, LibreOffice and POI draw it, a child is never skewed: its centre moves with the group, its
// turn adds the group's (negated by one flip), and its extents scale along the group's axes, swapped for a child
// turned sideways.
function inGroup(outer: Place, xfrm: Xfrm): Place {
    const child = xfrm.child ?? { x: xfrm.x, y: xfrm.y, cx: xfrm.cx, cy: xfrm.cy };
    const kx = child.cx > 0 ? xfrm.cx / child.cx : 1;
    const ky = child.cy > 0 ? xfrm.cy / child.cy : 1;
    const [cx, cy] = [xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2];
    const turned = turn(xfrm.rot, xfrm.flipH, xfrm.flipV);
    const mirrors = xfrm.flipH !== xfrm.flipV;
    return (shape) => {
        const centre = apply(turned, xfrm.x + (shape.x - child.x) * kx - cx, xfrm.y + (shape.y - child.y) * ky - cy);
        const rot = normalizeAngle(shape.rot);
        const sideways = (rot >= 45 && rot < 135) || (rot >= 225 && rot < 315);
        return outer({
            x: cx + centre.x,
            y: cy + centre.y,
            width: shape.width * (sideways ? ky : kx),
            height: shape.height * (sideways ? kx : ky),
            rot: (mirrors ? -shape.rot : shape.rot) + xfrm.rot,
            flipH: shape.flipH !== xfrm.flipH,
            flipV: shape.flipV !== xfrm.flipV,
        });
    };
}

type Box = { x: number; y: number; width: number; height: number; angle: number };

// A leaf's box in the frame. A mirrored one keeps its box, and a pie its mirrored arc.
type Placed = {
    box: Box;
    mirrored: boolean;
    start: { x: number; y: number };
    end: { x: number; y: number };
    xfrm: Xfrm;
};

function place(placeIn: Place, xfrm: Xfrm): Placed {
    const { x, y, width, height, rot, flipH, flipV } = placeIn({
        x: xfrm.x + xfrm.cx / 2,
        y: xfrm.y + xfrm.cy / 2,
        width: xfrm.cx,
        height: xfrm.cy,
        rot: xfrm.rot,
        flipH: xfrm.flipH,
        flipV: xfrm.flipV,
    });
    const corner = apply(turn(rot, flipH, flipV), width / 2, height / 2);
    return {
        // A flipV box turns half round, as PowerPoint draws its text; a flipH one keeps its turn.
        box: { x: x - width / 2, y: y - height / 2, width, height, angle: normalizeAngle(rot + (flipV ? 180 : 0)) },
        mirrored: flipH !== flipV,
        start: { x: x - corner.x, y: y - corner.y },
        end: { x: x + corner.x, y: y + corner.y },
        xfrm,
    };
}

// The canvas clips what overhangs a frame, so a box wholly outside it (a master's off-slide shape, copied onto every
// slide) would be stored unseen; a box a group scaled past a double is none.
function onFrame(box: Box, frame: Frame): boolean {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return false;
    const r = (box.angle * Math.PI) / 180;
    const [cos, sin] = [Math.abs(Math.cos(r)), Math.abs(Math.sin(r))];
    const [halfWidth, halfHeight] = [
        (box.width * cos + box.height * sin) / 2,
        (box.width * sin + box.height * cos) / 2,
    ];
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    return (
        cx + halfWidth >= 0 && cx - halfWidth <= frame.width && cy + halfHeight >= 0 && cy - halfHeight <= frame.height
    );
}

type Walk = {
    deck: DeckWalk;
    inheritance: SlideInheritance;
    presentation: Part;
    // The part whose relationships name the pictures.
    part: Part;
    // A layout's or master's shapes: its placeholders are prompts, never drawn on a slide.
    copied: boolean;
    out: SlideShapes;
};

export function readSlideShapes(deck: DeckWalk, inheritance: SlideInheritance, presentation: Part): SlideShapes {
    const out: SlideShapes = { elements: [], title: '' };
    // The frame: its name, a title of at most 100 characters, weighs nothing besides.
    weigh(deck, 1);
    const root: Place = (shape) => ({
        ...shape,
        x: shape.x * deck.scale + deck.offset.x,
        y: shape.y * deck.scale + deck.offset.y,
        width: shape.width * deck.scale,
        height: shape.height * deck.scale,
    });
    for (const part of [...decorationsOf(inheritance), inheritance.slide]) {
        const tree = spTreeOf(part.root);
        const walk: Walk = { deck, inheritance, presentation, part, copied: part !== inheritance.slide, out };
        if (tree) readTree(walk, xmlElements(tree), root, 0, undefined);
    }
    return out;
}

function readTree(walk: Walk, shapes: XmlElement[], placeIn: Place, depth: number, group: FillPaint | undefined): void {
    if (depth > MAX_GROUP_DEPTH) throw new ApiError(413, PRESENTATION_TOO_LARGE);
    for (const shape of shapes) {
        if (++walk.deck.shapes > MAX_ELEMENTS) throw new ApiError(413, PRESENTATION_TOO_LARGE);
        if (isAlternateContent(shape)) {
            readTree(walk, alternative(shape), placeIn, depth + 1, group);
            continue;
        }
        if (shape.ns !== P_NS || !DRAWN.has(shape.local)) continue;
        const cNvPr = xmlChild(nonVisualOf(shape) ?? shape, P_NS, 'cNvPr');
        if (cNvPr && isOn(xmlAttr(cNvPr, '', 'hidden'))) continue;
        if (shape.local === 'grpSp') {
            const grpSpPr = xmlChild(shape, P_NS, 'grpSpPr');
            const xfrm = readXfrm(grpSpPr && xmlChild(grpSpPr, A_NS, 'xfrm'));
            const fill = paintOf(fillIn(grpSpPr), walk.inheritance.theme, { group }) ?? group;
            readTree(walk, xmlElements(shape), xfrm ? inGroup(placeIn, xfrm) : placeIn, depth + 1, fill);
            continue;
        }
        if (shape.local === 'contentPart') {
            count(walk, DROPPED.object.code);
            continue;
        }
        const own = placeholderOf(shape);
        if (walk.copied && own) continue;
        const inherited = own ? inheritedPlaceholders(own, walk.inheritance) : [];
        const chain = [shape, ...inherited.map((placeholder) => placeholder.shape)];
        const xfrm = chain.map(xfrmOf).find((found) => found !== undefined);
        if (!xfrm) continue;
        const placed = place(placeIn, xfrm);
        if (!onFrame(placed.box, walk.deck.frame)) continue;
        const spPrs = chain.flatMap((link) => xmlChild(link, P_NS, 'spPr') ?? []);
        if (shape.local === 'graphicFrame') {
            const graphic = xmlChild(shape, A_NS, 'graphic');
            const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
            placeholderBox(walk, GRAPHIC_KINDS.get((data && xmlAttr(data, '', 'uri')) ?? '') ?? 'object', placed.box);
        } else if (shape.local === 'pic') readPicture(walk, shape, spPrs, placed);
        else readShape(walk, { shape, own, inherited, spPrs, placed, group });
    }
}

const DRAWN = new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame', 'contentPart']);

// spPr's a:xfrm, or a graphic frame's own p:xfrm.
function xfrmOf(shape: XmlElement): Xfrm | undefined {
    const spPr = xmlChild(shape, P_NS, 'spPr');
    return readXfrm(spPr ? xmlChild(spPr, A_NS, 'xfrm') : xmlChild(shape, P_NS, 'xfrm'));
}

function push(walk: Walk, element: NewVectorElement): void {
    if (++walk.deck.elements > MAX_ELEMENTS) throw new ApiError(413, PRESENTATION_TOO_LARGE);
    let weight = 1;
    for (const value of Object.values(element))
        if (typeof value === 'string') weight += Math.floor(value.length / CHARS_PER_UNIT);
    weigh(walk.deck, weight);
    walk.out.elements.push(element);
}

function weigh(deck: DeckWalk, weight: number): void {
    deck.weight += weight;
    if (deck.weight > MAX_PPTX_WEIGHT) throw new ApiError(413, PRESENTATION_TOO_LARGE);
}

// A drawn shape and what it inherits: its placeholder, the layout's and master's it takes from, the spPr of each
// nearest first, and where it lands.
type Leaf = {
    shape: XmlElement;
    own: Placeholder | undefined;
    inherited: Placeholder[];
    spPrs: XmlElement[];
    placed: Placed;
    group: FillPaint | undefined;
};

function readShape(walk: Walk, leaf: Leaf): void {
    const { shape, own, inherited, spPrs, placed, group } = leaf;
    const { theme } = walk.inheritance;
    const shaped = spPrs.find((spPr) => geometryOf(spPr) !== undefined);
    const geometry = (shaped && geometryOf(shaped)) ?? 'rect';
    const body = xmlChild(shape, P_NS, 'txBody');
    const style = xmlChild(shape, P_NS, 'style');
    const text =
        body &&
        richTextOf(
            {
                body,
                inherited: inherited.flatMap((placeholder) => xmlChild(placeholder.shape, P_NS, 'txBody') ?? []),
                listStyle: listStyleOf(own, walk.inheritance, walk.presentation),
                style,
            },
            theme,
            walk.deck.scale,
        );
    if (text && body && own && placeholderKind(own.type) === 'title' && !walk.copied) walk.out.title ||= titleOf(body);
    const paint = { fill: fillOf(spPrs, walk, group), ...strokeOf(spPrs, walk) };
    const { box } = placed;
    const painted = paint.fill !== TRANSPARENT_FILL_JSON || paint.strokeColor !== TRANSPARENT_COLOR;
    // A text box is the rectangle itself; any other shape carries its text in an unpainted box on top.
    const textOnTop = () =>
        text &&
        push(walk, {
            type: 'richtext',
            ...box,
            ...text,
            ...NO_STROKE,
            fill: TRANSPARENT_FILL_JSON,
            corners: 'straight',
        });
    const shapeAndText = (kind: NewVectorElement) => {
        if (painted) push(walk, { ...box, ...paint, ...kind });
        textOnTop();
    };
    switch (geometry) {
        case 'rect':
            if (text) push(walk, { type: 'richtext', ...box, ...text, ...paint, corners: 'straight' });
            else if (painted) push(walk, { type: 'rectangle', ...box, ...paint, corners: 'straight' });
            break;
        case 'roundRect':
            shapeAndText({ type: 'rectangle', corners: 'curved' });
            break;
        case 'ellipse':
            shapeAndText({ type: 'ellipse' });
            break;
        case 'diamond':
            shapeAndText({ type: 'diamond', corners: 'straight' });
            break;
        case 'pie':
            shapeAndText({ type: 'pie', ...pieAngles(shaped, placed) });
            break;
        case 'line':
        case 'straightConnector1':
            if (paint.strokeColor !== TRANSPARENT_COLOR) push(walk, lineOf(placed, paint, spPrs));
            textOnTop();
            break;
        default:
            // Other presets and custGeom: the text stays, the outline is X4b's.
            if (painted) count(walk, 'shapes-simplified');
            textOnTop();
    }
}

function geometryOf(spPr: XmlElement): string | undefined {
    const preset = xmlChild(spPr, A_NS, 'prstGeom');
    if (preset) return xmlAttr(preset, '', 'prst');
    return xmlChild(spPr, A_NS, 'custGeom') ? 'custGeom' : undefined;
}

// The title's text, one line, for the frame's name.
const MAX_TITLE_CHARS = 100;

function titleOf(body: XmlElement): string {
    const text = drawingLines(body).join(' ').replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, MAX_TITLE_CHARS).join('');
}

const TRANSPARENT_FILL_JSON = serializeFill({ type: 'solid', color: TRANSPARENT_COLOR, style: 'solid' });

type Stroke = { strokeColor: string; strokeWidth: number; strokeStyle: StrokeStyle };
const NO_STROKE: Stroke = { strokeColor: TRANSPARENT_COLOR, strokeWidth: PPTX_STYLE.strokeWidth, strokeStyle: 'solid' };

// The first fill the chain states, a placeholder's own before its layout's and master's; a shape stating none is
// unfilled until X4a-3 reads its p:style.
function fillOf(spPrs: XmlElement[], walk: Walk, group: FillPaint | undefined): string {
    const fill = spPrs.map(fillIn).find((found) => found !== undefined);
    const paint = paintOf(fill, walk.inheritance.theme, { group });
    return paint ? serializeFill({ ...paint, style: 'solid' }) : TRANSPARENT_FILL_JSON;
}

// The first a:ln the chain states; a line with no fill of its own is unstroked until X4a-3 reads its p:style.
function strokeOf(spPrs: XmlElement[], walk: Walk): Stroke {
    const ln = spPrs.map((spPr) => xmlChild(spPr, A_NS, 'ln')).find((found) => found !== undefined);
    const paint = ln && paintOf(fillIn(ln), walk.inheritance.theme);
    if (!ln || paint?.type !== 'solid' || paint.color === TRANSPARENT_COLOR) return NO_STROKE;
    const width = emu(xmlAttr(ln, '', 'w')) ?? DEFAULT_LINE_EMU;
    const dash = xmlAttr(xmlChild(ln, A_NS, 'prstDash') ?? ln, '', 'val');
    return {
        strokeColor: paint.color,
        strokeWidth: Math.max(0, width) * walk.deck.scale,
        strokeStyle: !dash || dash === 'solid' ? 'solid' : dash === 'dot' || dash === 'sysDot' ? 'dotted' : 'dashed',
    };
}

// A pie's adj1 and adj2 are angles on the ellipse as drawn in its own box; the kind's are its box-normalized circle's,
// which a group's scale leaves alone.
function pieAngles(spPr: XmlElement | undefined, placed: Placed): { startAngle: number; sweepAngle: number } {
    const guides = new Map<string, number>();
    const preset = spPr && xmlChild(spPr, A_NS, 'prstGeom');
    const list = preset && xmlChild(preset, A_NS, 'avLst');
    for (const gd of list ? xmlChildren(list, A_NS, 'gd') : []) {
        const [, value] = xmlAttr(gd, '', 'fmla')?.match(/^val\s+(-?\d+)$/) ?? [];
        if (value !== undefined) guides.set(xmlAttr(gd, '', 'name') ?? '', Number(value) / 60_000);
    }
    const { cx: width, cy: height } = placed.xfrm;
    const parametric = (visual: number) => {
        const r = (visual * Math.PI) / 180;
        return normalizeAngle((Math.atan2(width * Math.sin(r), height * Math.cos(r)) * 180) / Math.PI);
    };
    const start = parametric(guides.get('adj1') ?? 0);
    const end = parametric(guides.get('adj2') ?? 270);
    const sweep = normalizeAngle(end - start) || 360;
    // A mirrored slice runs the other way round its box.
    return { startAngle: placed.mirrored ? normalizeAngle(180 - start - sweep) : start, sweepAngle: sweep };
}

function lineOf(placed: Placed, stroke: Stroke, spPrs: XmlElement[]): NewVectorElement {
    const { start, end } = placed;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const ln = spPrs.map((spPr) => xmlChild(spPr, A_NS, 'ln')).find((found) => found !== undefined);
    const head = (local: string) => {
        const decoration = ln && xmlChild(ln, A_NS, local);
        return ARROWHEADS.get((decoration && xmlAttr(decoration, '', 'type')) ?? 'none') ?? 'none';
    };
    const line = {
        x,
        y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        angle: 0,
        points: JSON.stringify([
            [start.x - x, start.y - y],
            [end.x - x, end.y - y],
        ]),
        roundness: 'sharp',
        ...stroke,
    } satisfies VectorElementPatch;
    const [startArrowhead, endArrowhead] = [head('headEnd'), head('tailEnd')];
    return startArrowhead === 'none' && endArrowhead === 'none'
        ? { type: 'line', ...line }
        : { type: 'arrow', ...line, startArrowhead, endArrowhead, elbow: false };
}

function readPicture(walk: Walk, shape: XmlElement, spPrs: XmlElement[], { box }: Placed): void {
    const blipFill = xmlChild(shape, P_NS, 'blipFill');
    const blip = blipFill && xmlChild(blipFill, A_NS, 'blip');
    const extensions = blip && xmlChild(blip, A_NS, 'extLst');
    const svg = (extensions ? xmlChildren(extensions, A_NS, 'ext') : [])
        .map((ext) => xmlChild(ext, ASVG_NS, 'svgBlip'))
        .find((found) => found !== undefined);
    const embedded = (element: XmlElement | undefined) => element && xmlAttr(element, R_NS, 'embed');
    const part = walk.deck.pkg.media(walk.part, embedded(svg)) ?? walk.deck.pkg.media(walk.part, embedded(blip));
    if (!part) {
        // A blip naming no picture is an empty placeholder's prompt, not a picture.
        if (embedded(blip) || (blip && xmlAttr(blip, R_NS, 'link'))) placeholderBox(walk, 'picture', box);
        return;
    }
    push(walk, {
        type: 'image',
        ...box,
        ...strokeOf(spPrs, walk),
        mediaName: walk.deck.mediaName(part),
        objectFit: 'fill',
        corners: 'straight',
    });
}

function count(walk: Walk, code: CountedWarningCode): void {
    walk.deck.dropped.set(code, (walk.deck.dropped.get(code) ?? 0) + 1);
}

// Q5: a loss the user can see on the slide, saying what was there.
function placeholderBox(walk: Walk, what: Dropped, box: Box): void {
    count(walk, DROPPED[what].code);
    push(walk, {
        type: 'richtext',
        ...box,
        html: `<p>${escapeHtml(DROPPED[what].label)}</p>`,
        fill: serializeFill({ type: 'solid', color: PLACEHOLDER_BOX.fill, style: 'solid' }),
        strokeColor: PLACEHOLDER_BOX.stroke,
        strokeWidth: 2,
        strokeStyle: 'dashed',
        corners: 'straight',
        color: PLACEHOLDER_BOX.text,
        fontSize: Math.min(32, Math.max(12, box.height / 4)),
        textAlign: 'center',
        verticalAlign: 'center',
    });
}
