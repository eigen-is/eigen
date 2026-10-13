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
export const MAX_MEDIA_PARTS = 1000;

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

// What a walk over one deck shares: its budget, its pictures, its losses.
export type DeckWalk = {
    pkg: PptxPackage;
    // The frame's px per EMU, and where the slide's origin lands in the frame.
    scale: number;
    offset: { x: number; y: number };
    // Shapes walked and elements written, each capped: a master's shapes are walked again for every slide.
    shapes: number;
    elements: number;
    // A picture part's media name, the first time a slide shows it.
    mediaName(part: MediaPart): string;
    dropped: Map<CountedWarningCode, number>;
};

export type SlideShapes = { elements: NewVectorElement[]; title: string };

// x' = a·x + c·y + e, y' = b·x + d·y + f: from a shape tree's coordinates, in EMU, to the frame's px.
type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

function compose(m: Affine, n: Affine): Affine {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function apply(m: Affine, x: number, y: number): { x: number; y: number } {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];

// A rotation by `rot` degrees clockwise (y down) after the flips, as DrawingML applies them about a box's centre.
function turn(rot: number, flipH: boolean, flipV: boolean): Affine {
    const r = (rot * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const [h, v] = [flipH ? -1 : 1, flipV ? -1 : 1];
    return [cos * h, sin * h, -sin * v, cos * v, 0, 0];
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

// A group's children are laid out in its chOff/chExt space, scaled onto its off/ext, then flipped and turned with it.
function groupTransform(m: Affine, xfrm: Xfrm): Affine {
    const child = xfrm.child ?? { x: xfrm.x, y: xfrm.y, cx: xfrm.cx, cy: xfrm.cy };
    const kx = child.cx > 0 ? xfrm.cx / child.cx : 1;
    const ky = child.cy > 0 ? xfrm.cy / child.cy : 1;
    const [cx, cy] = [xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2];
    const placed: Affine = [kx, 0, 0, ky, xfrm.x - child.x * kx, xfrm.y - child.y * ky];
    const about = compose(translate(cx, cy), compose(turn(xfrm.rot, xfrm.flipH, xfrm.flipV), translate(-cx, -cy)));
    return compose(m, compose(about, placed));
}

type Box = { x: number; y: number; width: number; height: number; angle: number };

// A leaf's box in the frame: its own turn and flips about its centre, then every group's. A skewed result (a turned
// shape in a group scaled unevenly) keeps its axes' lengths; a mirrored one keeps its box, and a pie its mirrored arc.
type Placed = { box: Box; mirrored: boolean; start: { x: number; y: number }; end: { x: number; y: number } };

function place(m: Affine, xfrm: Xfrm): Placed {
    const local = compose(
        m,
        compose(translate(xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2), turn(xfrm.rot, xfrm.flipH, xfrm.flipV)),
    );
    const centre = apply(local, 0, 0);
    const width = Math.hypot(local[0], local[1]) * xfrm.cx;
    const height = Math.hypot(local[2], local[3]) * xfrm.cy;
    // From the box's y axis: a flipH box keeps its turn and a flipV one turns half round, as PowerPoint draws its text.
    const angle = normalizeAngle((Math.atan2(local[3], local[2]) * 180) / Math.PI - 90);
    return {
        box: { x: centre.x - width / 2, y: centre.y - height / 2, width, height, angle },
        mirrored: local[0] * local[3] - local[1] * local[2] < 0,
        start: apply(local, -xfrm.cx / 2, -xfrm.cy / 2),
        end: apply(local, xfrm.cx / 2, xfrm.cy / 2),
    };
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
    const root: Affine = [deck.scale, 0, 0, deck.scale, deck.offset.x, deck.offset.y];
    for (const part of [...decorationsOf(inheritance), inheritance.slide]) {
        const tree = spTreeOf(part.root);
        const walk: Walk = { deck, inheritance, presentation, part, copied: part !== inheritance.slide, out };
        if (tree) readTree(walk, xmlElements(tree), root, 0, undefined);
    }
    return out;
}

function readTree(walk: Walk, shapes: XmlElement[], m: Affine, depth: number, group: FillPaint | undefined): void {
    if (depth > MAX_GROUP_DEPTH) throw new ApiError(413, PRESENTATION_TOO_LARGE);
    for (const shape of shapes) {
        if (isAlternateContent(shape)) {
            readTree(walk, alternative(shape), m, depth + 1, group);
            continue;
        }
        if (shape.ns !== P_NS || !DRAWN.has(shape.local) || isHidden(shape)) continue;
        if (++walk.deck.shapes > MAX_ELEMENTS) throw new ApiError(413, PRESENTATION_TOO_LARGE);
        const own = placeholderOf(shape);
        if (walk.copied && own) continue;
        const inherited = own ? inheritedPlaceholders(own, walk.inheritance) : [];
        const chain = [shape, ...inherited.map((placeholder) => placeholder.shape)];
        if (shape.local === 'grpSp') {
            const grpSpPr = xmlChild(shape, P_NS, 'grpSpPr');
            const xfrm = readXfrm(grpSpPr && xmlChild(grpSpPr, A_NS, 'xfrm'));
            const fill = paintOf(fillIn(grpSpPr), walk.inheritance.theme, { group }) ?? group;
            readTree(walk, xmlElements(shape), xfrm ? groupTransform(m, xfrm) : m, depth + 1, fill);
            continue;
        }
        if (shape.local === 'contentPart') {
            count(walk, DROPPED.object.code);
            continue;
        }
        const xfrm = chain.map(xfrmOf).find((found) => found !== undefined);
        if (!xfrm) continue;
        const placed = place(m, xfrm);
        if (shape.local === 'graphicFrame') readGraphicFrame(walk, shape, placed.box);
        else if (shape.local === 'pic') readPicture(walk, shape, chain, placed.box);
        else readShape(walk, shape, own, inherited, chain, { ...placed, xfrm }, group);
    }
}

const DRAWN = new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame', 'contentPart']);

function isHidden(shape: XmlElement): boolean {
    const nv = nonVisualOf(shape);
    const cNvPr = nv && xmlChild(nv, P_NS, 'cNvPr');
    return (cNvPr && isOn(xmlAttr(cNvPr, '', 'hidden'))) ?? false;
}

// spPr's a:xfrm, or a graphic frame's own p:xfrm.
function xfrmOf(shape: XmlElement): Xfrm | undefined {
    const spPr = xmlChild(shape, P_NS, 'spPr');
    return readXfrm(spPr ? xmlChild(spPr, A_NS, 'xfrm') : xmlChild(shape, P_NS, 'xfrm'));
}

function push(walk: Walk, element: NewVectorElement): void {
    if (++walk.deck.elements > MAX_ELEMENTS) throw new ApiError(413, PRESENTATION_TOO_LARGE);
    walk.out.elements.push(element);
}

function readShape(
    walk: Walk,
    shape: XmlElement,
    own: Placeholder | undefined,
    inherited: Placeholder[],
    chain: XmlElement[],
    placed: Placed & { xfrm: Xfrm },
    group: FillPaint | undefined,
): void {
    const { theme } = walk.inheritance;
    const spPrs = chain.flatMap((link) => xmlChild(link, P_NS, 'spPr') ?? []);
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
function pieAngles(
    spPr: XmlElement | undefined,
    placed: Placed & { xfrm: Xfrm },
): { startAngle: number; sweepAngle: number } {
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

function readPicture(walk: Walk, shape: XmlElement, chain: XmlElement[], box: Box): void {
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
    const spPrs = chain.flatMap((link) => xmlChild(link, P_NS, 'spPr') ?? []);
    push(walk, {
        type: 'image',
        ...box,
        ...strokeOf(spPrs, walk),
        mediaName: walk.deck.mediaName(part),
        objectFit: 'fill',
        corners: 'straight',
    });
}

function readGraphicFrame(walk: Walk, shape: XmlElement, box: Box): void {
    const graphic = xmlChild(shape, A_NS, 'graphic');
    const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
    placeholderBox(walk, GRAPHIC_KINDS.get((data && xmlAttr(data, '', 'uri')) ?? '') ?? 'object', box);
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
