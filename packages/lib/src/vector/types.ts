// The eigen canvas element model, a React-free shared core like the sheets one. The element shape is Excalidraw's
// `_ExcalidrawElementBase`, trimmed to what Eigen's Yjs CRDT needs: no tombstones, no version or versionNonce, and no
// groupIds. Every stored field is a scalar or a string, so arrays such as points, comment cards and fills ride as JSON
// strings.

import type { ChartSpecPartKey } from '../types/chart';
import type { SlideSize, VectorFrame } from './frames';

export type VectorElementType =
    | 'rectangle'
    | 'diamond'
    | 'ellipse'
    | 'pie'
    | 'image'
    | 'freedraw'
    | 'line'
    | 'arrow'
    | 'chart'
    | 'path';

// The value lists are the one source, and the union types derive from them, so a list and its type can't drift.
// The reader validates against the same arrays. The hatch style is part of the fill and not a field of its own: it
// rides the stored `fill` JSON beside the paint, so a kind that fills carries one field.
export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const;
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const ROUNDNESS = ['sharp', 'round'] as const;
// Corner treatment for the box kinds: the rectangle, the diamond and the image. Lines and arrows keep `roundness`
// (sharp vs curved polyline), which is a different question.
export const CORNERS = ['straight', 'curved', 'round'] as const;
export const OBJECT_FITS = ['fill', 'contain', 'cover'] as const;
// Docs' TextAlign values too, in the order its toolbar lists them.
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export const VERTICAL_ALIGNS = ['top', 'center', 'bottom'] as const;
export const FONT_WEIGHTS = ['normal', 'bold'] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;
export const TEXT_DECORATIONS = ['none', 'underline', 'line-through'] as const;
// The heads an arrow's ends can have: Excalidraw's, trimmed to the shapes Eigen draws.
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'bar', 'circle'] as const;
// The three arrow shapes the panel offers. They are not a stored field. Sharp and curved are the arrow's
// `roundness`, as on a line, and elbow is the stored `elbow` flag. So one field still says how curved a shaft is,
// and an arrow that stores only `roundness` reads back unchanged.
export const ARROW_SHAPES = ['sharp', 'curved', 'elbow'] as const;

export type FillStyle = (typeof FILL_STYLES)[number];
export type StrokeStyle = (typeof STROKE_STYLES)[number];
export type Roundness = (typeof ROUNDNESS)[number];
export type Corners = (typeof CORNERS)[number];
export type ObjectFit = (typeof OBJECT_FITS)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];
type FontWeight = (typeof FONT_WEIGHTS)[number];
type FontStyle = (typeof FONT_STYLES)[number];
type TextDecoration = (typeof TEXT_DECORATIONS)[number];
export type Arrowhead = (typeof ARROWHEADS)[number];
export type ArrowShape = (typeof ARROW_SHAPES)[number];

export type VectorElementBase = {
    id: string;
    type: VectorElementType;
    x: number;
    y: number;
    width: number;
    height: number;
    // In degrees, clockwise, with y pointing down, as SVG's rotate() takes it.
    angle: number;
    // The z-order, as a fractional index.
    index: string;
    // Empty on the infinite canvas. When set, x and y are relative to that frame's origin.
    frameId: string;
    // A JSON `["id",…]` string like `points`, so every stored field stays a scalar.
    commentCardIds: string;
    // From 0 to 100.
    opacity: number;
    strokeColor: string;
    strokeWidth: number;
    strokeStyle: StrokeStyle;
    // roughjs jitter, on every kind, the image included, so one table answers how sketchy an element is.
    roughness: number;
    seed: number;
};

// A serialized Fill, its paint and hatch style as JSON. An empty or malformed one reads as the transparent solid
// fill.
type Fillable = { fill: string };

// The text a box or a closed shape holds: its HTML and its typography, one block every text kind composes.
export type Textual = {
    html: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: FontWeight;
    fontStyle: FontStyle;
    textDecoration: TextDecoration;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    color: string;
    letterSpacing: number;
    lineHeight: number;
    // The inset in px between the box's edge and its text. The box keeps its stored size.
    padding: number;
};

// A rectangle with `autoFit` is a text box, which grows to fit its text. A plain one keeps its size and lets text that
// does not fit spill out.
export type VectorRectangleElement = VectorElementBase &
    Fillable &
    Textual & { type: 'rectangle'; corners: Corners; autoFit: boolean };
export type VectorDiamondElement = VectorElementBase & Fillable & Textual & { type: 'diamond'; corners: Corners };
// An ellipse has no corners, so it carries no `corners` field, and its capabilities hide the panel's row.
export type VectorEllipseElement = VectorElementBase & Fillable & Textual & { type: 'ellipse' };

// The roughjs-drawn closed shapes.
export type VectorShapeElement = VectorRectangleElement | VectorDiamondElement | VectorEllipseElement;

// A sector of the ellipse in its box, OOXML's `pie`. Its angles are degrees clockwise from 3 o'clock on the circle
// the box is stretched from, so a resize scales the slice like any shape. It stores a start and a sweep, because a
// 360° slice has no end of its own.
export type VectorPieElement = VectorElementBase &
    Fillable &
    Textual & {
        type: 'pie';
        // From 0 up to but not including 360.
        startAngle: number;
        // Above 0, up to and including 360.
        sweepAngle: number;
    };

// A free contour of lines and Bézier curves (a pptx custGeom). `path` is absolute M/L/C/Q/Z in the unit
// box, the canonical string parseNormalizedPath writes, so a resize changes width/height and never the path.
// A hole is a subpath wound the other way, where SVG's nonzero fill and roughjs's even-odd hatching agree.
// An open path keeps the text it stores, but reads, draws and offers none until it closes.
export type VectorPathElement = VectorElementBase &
    Fillable &
    Textual & {
        type: 'path';
        path: string;
        // Whether the path fills; it reads false for a path without a Z. An open path only strokes.
        closed: boolean;
    };

export type VectorImageElement = VectorElementBase & {
    type: 'image';
    // A file name in the container's media folder, never a data URL.
    mediaName: string;
    corners: Corners;
    objectFit: ObjectFit;
};

// The kinds that hold text. The runtime answer is the `text` capability (isTextual); the registry test pins the two.
export type VectorTextualElement = VectorShapeElement | VectorPieElement | VectorPathElement;

// One line of plain text in a kind's local frame, as svgTextLine draws it. y is the line's top, and a renderer
// adds the font's baseline offset. The line turns `rotate` degrees about (x, y).
export type TextLine = {
    text: string;
    x: number;
    y: number;
    anchor: 'start' | 'middle' | 'end';
    fontFamily: string;
    fontSize: number;
    bold: boolean;
    color: string;
    rotate: number;
};

// A chart: its ChartSpec as a JSON string per part, `specChart` … `specData`, so two peers who edit two parts both keep
// their edit. On a canvas a chart holds inline data only. `fill` is its background and the hatch style of its bars and
// slices. The stroke draws its axes and gridlines. `color` is its labels' color, and their font is the spec's.
// `seriesStrokeWidth` is the width of a line series, which an Office import sets. Where it is unset, a line series
// draws at the stroke's width.
export type VectorChartElement = VectorElementBase &
    Fillable &
    Record<ChartSpecPartKey, string> & {
        type: 'chart';
        color: string;
        seriesStrokeWidth?: number;
    };

// What an arrow endpoint may dock to: the closed shapes, the pie slice, a closed path, the chart and the image, whose
// outline is the rounded rect its `corners` describes. At run time the answer is the registry's `bindable`
// capability, and this union is its type. The registry test pins the two, so neither grows without the other.
export type VectorBindableElement =
    | VectorShapeElement
    | VectorPieElement
    | VectorPathElement
    | VectorChartElement
    | VectorImageElement;

// Freehand strokes and lines. `points` is a JSON `[[x,y],…]` string in scene units, relative to x and y. The points'
// bounding box always starts at (0, 0), which normalizeLinear keeps true.
export type VectorLinearElement = VectorElementBase &
    Fillable & {
        type: 'freedraw' | 'line';
        points: string;
        // A round line draws a roughjs curve through its vertices. A freehand stroke ignores it.
        roundness: Roundness;
        // The pen's pressure at each point of a freehand stroke, as a JSON `[p0,…]` string in the order of `points`,
        // or empty for none. With `simulatePressure` off, perfect-freehand draws these real widths, as Excalidraw
        // does. Otherwise it simulates them from the pen's speed. Pressure has a field of its own, because the
        // reader writes each point back as a pair and would drop a third value.
        pressures: string;
        simulatePressure: boolean;
    };

// An arrow is a line with heads, a binding at each end and an optional label. It has a `type` of its own, so
// `el.type === 'arrow'` narrows straight to its fields. `startBinding` and `endBinding` are a JSON
// `{"elementId","fixedPoint":[fx,fy]}` string, or empty when unbound. Which arrows a shape has is derived, never
// stored.
export type VectorArrowElement = VectorElementBase & {
    type: 'arrow';
    points: string;
    roundness: Roundness;
    // An elbow arrow stores this flag, its two endpoints and its bindings. Its route of straight runs is derived
    // each time it is read or drawn, never stored. Its angle is always 0, because the route lives in the unturned
    // local frame, and the reader forces that. Its `roundness` is the style of its bends.
    elbow: boolean;
    // The pinned segments of an elbow arrow, Excalidraw's fixedSegments, or empty when none. Once a segment is
    // pinned, `points` holds the whole route, the pin editors change it, and the router never runs on the arrow. The
    // string is a JSON `{"segments":[{index,start,end},…],"startIsSpecial","endIsSpecial"}`. A pin's index names the
    // segment that ends at `points[index]`, and its start and end are local copies of that segment's two points. The
    // two flags mark an extra point the router adds next to an end. A straight arrow ignores the field.
    fixedSegments: string;
    startArrowhead: Arrowhead;
    endArrowhead: Arrowhead;
    startBinding: string;
    endBinding: string;
    // The optional label, or empty for none. It is the one plain-text field left on the canvas.
    text: string;
    fontSize: number;
    fontFamily: string;
    // Measured in the browser. It is the only source of the label's width.
    labelWidth: number;
};

export type VectorElement =
    | VectorShapeElement
    | VectorPieElement
    | VectorPathElement
    | VectorChartElement
    | VectorImageElement
    | VectorLinearElement
    | VectorArrowElement;

// The element type a `type` key stands for, which narrows the registry per kind. It tests membership and not
// `Extract<VectorElement, { type: K }>`, because a freehand stroke and a line share one element type whose `type`
// is the pair, which Extract would match for neither.
type OfType<T, K> = T extends { type: infer U } ? (K extends U ? T : never) : never;
export type ElementOfType<K extends VectorElementType> = OfType<VectorElement, K>;

// A patch over the stored fields. Every field is optional, so a caller sets any of any kind's fields. An id and a
// type are never patched, and a z-order change rewrites `index`.
export type VectorElementPatch = Partial<Omit<VectorShapeElement, 'id' | 'type'>> &
    Partial<Omit<VectorRectangleElement, 'id' | 'type'>> &
    Partial<Omit<VectorPieElement, 'id' | 'type'>> &
    Partial<Omit<VectorPathElement, 'id' | 'type'>> &
    Partial<Omit<VectorChartElement, 'id' | 'type'>> &
    Partial<Omit<VectorImageElement, 'id' | 'type'>> &
    Partial<Omit<VectorLinearElement, 'id' | 'type'>> &
    Partial<Omit<VectorArrowElement, 'id' | 'type'>>;

// A new element. The caller names a `type` and sets whatever it likes, and the writer fills in the rest from the
// kind's defaults, with a new id and seed.
export type NewVectorElement = { type: VectorElementType } & VectorElementPatch;

// A binding: an anchor stored as a fraction of the target shape's width and height, so it follows the shape. It is
// not clamped when written. Readers clamp it to [0, 1].
type Binding = { elementId: string; fixedPoint: [number, number] };

// One pinned segment, Excalidraw's FixedSegment. `index` names it: the segment that ends at `points[index]`. `start`
// and `end` are local copies of its two points, which share exactly one coordinate. Every writer rebuilds them
// from the normalized points, so the copies never drift from the index.
export type FixedSegment = { index: number; start: [number, number]; end: [number, number] };

// A pinned elbow arrow's whole pin state, decoded from its fixedSegments string: the pins and the two flags.
type ParsedFixedSegments = { segments: FixedSegment[]; startIsSpecial: boolean; endIsSpecial: boolean };

// `slideWidth` is the deck's physical width in pt (frames.ts).
export type VectorMeta = { background: string; slideSize: SlideSize; slideWidth: number };
// A deck's page: its shape and its physical width.
export type SlidePage = Pick<VectorMeta, 'slideSize' | 'slideWidth'>;

export type VectorScene = { elements: VectorElement[]; frames: VectorFrame[]; meta: VectorMeta };

// The stored fields every kind shares. Each kind adds its own, and the registry assembles the whole list,
// ELEMENT_FIELDS.
export const BASE_ELEMENT_FIELDS = [
    'id',
    'type',
    'x',
    'y',
    'width',
    'height',
    'angle',
    'index',
    'frameId',
    'commentCardIds',
    'opacity',
    'strokeColor',
    'strokeWidth',
    'strokeStyle',
    'roughness',
    'seed',
] as const;

export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_FAMILY = 'Excalifont';
export const DEFAULT_FILL_STYLE: FillStyle = 'solid';
export const DEFAULT_CORNERS: Corners = 'curved';
export const DEFAULT_OBJECT_FIT: ObjectFit = 'contain';
// A freehand stroke draws sharp, as Excalidraw's stores no roundness. The reader also falls back to this for a line
// or arrow without the field, so a stored element keeps its meaning.
export const DEFAULT_LINEAR_ROUNDNESS: Roundness = 'sharp';
// A new line curves, as Excalidraw's currentItemRoundness starts round. A freehand stroke's default is sharp, so the
// line has a constant of its own.
export const DEFAULT_LINE_ROUNDNESS: Roundness = 'round';
// A new arrow curves, as in Excalidraw. The reader's fallback stays sharp, so a stored arrow keeps its meaning.
const DEFAULT_ARROW_ROUNDNESS: Roundness = 'round';

// Canvas-level defaults (the `meta` root). A new deck is PowerPoint's widescreen, 16:9 and 13.33 in wide, so a pt is
// 2 px of the frame; a deck that stores no width reads as UNSTORED_SLIDE_WIDTH instead (frames.ts).
export const DEFAULT_SCENE_META: VectorMeta = { background: 'transparent', slideSize: '16:9', slideWidth: 960 };

// Shared element defaults, adopted from Excalidraw's DEFAULT_ELEMENT_PROPS.
export const DEFAULT_ELEMENT_PROPS = {
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    strokeStyle: 'solid',
    opacity: 100,
    frameId: '',
    commentCardIds: '',
    // The reader's fallback, not a new element's. A stored element with no roughness stays crisp in both apps, and a
    // new one is as sketchy as its app's style table says. The seed is never 0, because roughjs reads 0 as "pick a
    // random one" and would draw new jitter every time.
    roughness: 0,
    seed: 1,
} satisfies Pick<
    VectorElementBase,
    'strokeColor' | 'strokeWidth' | 'strokeStyle' | 'opacity' | 'frameId' | 'commentCardIds' | 'roughness' | 'seed'
>;

// The typography a kind's text starts in beyond the host's style table, which gives the font, the size and the
// color. It is also the fallback a corrupt stored value reads as.
export type TextProps = Omit<Textual, 'html' | 'fontFamily' | 'fontSize' | 'color'>;

// A text box's text starts at its top left, flush with its edge.
export const DEFAULT_TEXT_BOX_PROPS = {
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'left',
    verticalAlign: 'top',
    letterSpacing: 0,
    lineHeight: 1.2,
    padding: 0,
} satisfies TextProps;

// A shape's text starts in its middle, inset from its edge.
export const DEFAULT_SHAPE_TEXT_PROPS = {
    ...DEFAULT_TEXT_BOX_PROPS,
    textAlign: 'center',
    verticalAlign: 'center',
    padding: 10,
} satisfies TextProps;

// What a new arrow starts with, Excalidraw's: a head on its end only, no bindings and no label.
export const DEFAULT_ARROW_PROPS = {
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding: '',
    elbow: false,
    fixedSegments: '',
    text: '',
    fontSize: DEFAULT_FONT_SIZE,
    fontFamily: DEFAULT_FONT_FAMILY,
    labelWidth: 0,
    roundness: DEFAULT_ARROW_ROUNDNESS,
} satisfies Pick<
    VectorArrowElement,
    | 'startArrowhead'
    | 'endArrowhead'
    | 'startBinding'
    | 'endBinding'
    | 'elbow'
    | 'fixedSegments'
    | 'text'
    | 'fontSize'
    | 'fontFamily'
    | 'labelWidth'
    | 'roundness'
>;

// The labels of the Roundness values, for the panel's Edges row. On an elbow arrow they name the style of its
// bends.
export const EDGES_OPTIONS: { value: Roundness; label: string }[] = [
    { value: 'sharp', label: 'Sharp' },
    { value: 'round', label: 'Rounded' },
];

// A property of a parsed JSON object, read without a cast, since Reflect.get accepts any object. Every decoder in
// the vector model reads this way.
export function prop(target: object, key: string): unknown {
    return Reflect.get(target, key);
}

// A comment-card list is a JSON scalar like `points`; '' and anything malformed read as no cards.
export function parseIdList(value: string): string[] {
    if (value === '') return [];
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string' && entry !== '') out.push(entry);
    }
    return out;
}

export function serializeIdList(ids: string[]): string {
    return ids.length === 0 ? '' : JSON.stringify(ids);
}

// The linear kinds, a freehand stroke, a line and an arrow, which carry a `points` string. One guard narrows them
// all, so reading `.points` or `.roundness` has one owner as the family grows.
export function isLinearElement(el: VectorElement): el is VectorLinearElement | VectorArrowElement {
    return el.type === 'freedraw' || el.type === 'line' || el.type === 'arrow';
}

// A binding is a JSON `{"elementId","fixedPoint":[fx,fy]}` string, or empty when unbound. Any ratio passes,
// because a shrunk shape can push one outside [0, 1], and readers clamp it where they use it.
export function parseBinding(s: string): Binding | null {
    if (s === '') return null;
    let raw: unknown;
    try {
        raw = JSON.parse(s);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const elementId = prop(raw, 'elementId');
    const fixedPoint = prop(raw, 'fixedPoint');
    if (typeof elementId !== 'string' || elementId === '') return null;
    if (!Array.isArray(fixedPoint) || fixedPoint.length !== 2) return null;
    const [fx, fy] = fixedPoint;
    if (typeof fx !== 'number' || typeof fy !== 'number' || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    return { elementId, fixedPoint: [fx, fy] };
}

export function serializeBinding(b: Binding): string {
    return JSON.stringify({ elementId: b.elementId, fixedPoint: b.fixedPoint });
}

// The pins of a fixedSegments string, without anything malformed. A pin needs an integer index and a start and an
// end that share exactly one coordinate and differ in the other. An empty or unusable string has no pins, so a
// corrupt peer write can't jam the arrow or make the scene throw. An older bare array without indexes has none
// too.
export function parseFixedSegments(s: string): ParsedFixedSegments {
    const empty: ParsedFixedSegments = { segments: [], startIsSpecial: false, endIsSpecial: false };
    if (s === '') return empty;
    let raw: unknown;
    try {
        raw = JSON.parse(s);
    } catch {
        return empty;
    }
    // Only the object form counts. A bare array is the older form and is dropped.
    if (typeof raw !== 'object' || raw === null) return empty;
    const segments = prop(raw, 'segments');
    if (!Array.isArray(segments)) return empty;
    const out: FixedSegment[] = [];
    for (const entry of segments) {
        const seg = fixedSegmentOf(entry);
        if (seg) out.push(seg);
    }
    return {
        segments: out,
        startIsSpecial: prop(raw, 'startIsSpecial') === true,
        endIsSpecial: prop(raw, 'endIsSpecial') === true,
    };
}

function fixedSegmentOf(entry: unknown): FixedSegment | null {
    if (typeof entry !== 'object' || entry === null) return null;
    const index = prop(entry, 'index');
    const start = prop(entry, 'start');
    const end = prop(entry, 'end');
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) return null;
    const s = pairOf(start);
    const e = pairOf(end);
    if (!s || !e) return null;
    const horizontal = s[1] === e[1];
    const vertical = s[0] === e[0];
    // The two ends share exactly one coordinate, so the segment is straight and has a length.
    if (horizontal === vertical) return null;
    return { index, start: s, end: e };
}

function pairOf(v: unknown): [number, number] | null {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [a, b] = v;
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return [a, b];
}

// The pins as a fixedSegments string, or empty when there are none, which lets the router route the arrow again.
export function serializeFixedSegments(parsed: ParsedFixedSegments): string {
    if (parsed.segments.length === 0) return '';
    return JSON.stringify({
        segments: parsed.segments.map((s) => ({ index: s.index, start: s.start, end: s.end })),
        startIsSpecial: parsed.startIsSpecial,
        endIsSpecial: parsed.endIsSpecial,
    });
}

// Each shape's id with the arrows bound to it at either end. It is derived and never stored, so no write has to
// keep two elements in step. An arrow bound to one shape at both ends is listed once.
export function arrowsBoundTo(elements: VectorElement[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const el of elements) {
        if (el.type !== 'arrow') continue;
        for (const bindingStr of [el.startBinding, el.endBinding]) {
            const b = parseBinding(bindingStr);
            if (!b) continue;
            const list = map.get(b.elementId);
            if (!list) map.set(b.elementId, [el.id]);
            else if (!list.includes(el.id)) list.push(el.id);
        }
    }
    return map;
}

// The shape the panel's Arrow type row shows, from the stored `elbow` flag and `roundness`.
export function arrowShapeOf(el: VectorArrowElement): ArrowShape {
    return el.elbow ? 'elbow' : el.roundness === 'round' ? 'curved' : 'sharp';
}

// The stored fields a chosen arrow shape writes. Elbow sets only the flag and keeps `roundness`, because on an
// elbow arrow that is the style of its bends, which the Edges row sets. Curved and sharp clear the flag and set
// the shaft's roundness.
export function arrowShapeFields(shape: ArrowShape): { elbow: boolean; roundness?: Roundness } {
    if (shape === 'elbow') return { elbow: true };
    return { elbow: false, roundness: shape === 'curved' ? 'round' : 'sharp' };
}
