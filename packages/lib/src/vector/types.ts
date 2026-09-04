// The eigen canvas element model. React-free shared core (the packages/lib/src/sheets
// precedent). Element shape adopted from Excalidraw's `_ExcalidrawElementBase`, trimmed to
// what Eigen's Yjs CRDT needs: no tombstones, no version/versionNonce, no groupIds. Every
// stored field is a scalar or a string — arrays (points, comment cards, fills) ride JSON scalars.

import type { VectorFrame } from './frames';

export type VectorElementType =
    | 'rectangle'
    | 'diamond'
    | 'ellipse'
    | 'image'
    | 'richtext'
    | 'freedraw'
    | 'line'
    | 'arrow';

// The runtime value lists are the single source; the union types derive from them, so a grown
// list and its type can never drift. read-vector's validators consume the same arrays.
// The hatch style is HALF OF THE FILL, not a field of its own: it rides the stored `fill` JSON beside
// the paint (types/background.ts derives `Fill` from the pair), so a kind that fills carries one field.
export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const;
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const ROUNDNESS = ['sharp', 'round'] as const;
// Corner treatment for the box kinds. Replaces `roundness` on rectangle/diamond and reaches image and
// rich text; lines and arrows keep `roundness` (sharp vs curved polyline), which is a different question.
export const CORNERS = ['straight', 'curved', 'round'] as const;
export const OBJECT_FITS = ['fill', 'contain', 'cover'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export const VERTICAL_ALIGNS = ['top', 'center', 'bottom'] as const;
export const FONT_WEIGHTS = ['normal', 'bold'] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;
export const TEXT_DECORATIONS = ['none', 'underline', 'line-through'] as const;
// Arrowhead vocabulary (both ends), Excalidraw's trimmed to the shapes we draw. read-vector validates
// against this array; the panel's start/end selects list it.
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'bar', 'circle'] as const;
// The 3-way arrow-shape vocabulary the panel offers. It is a DERIVED UI concept, not a stored field:
// 'sharp'/'curved' are the existing `roundness` (sharp linearPath vs round curve shaft), and 'elbow' is the
// one new stored boolean below. Keeping roundness as the single owner of shaft curvature (shared with
// line/freedraw) means an arrow carrying only `roundness` reads back unchanged (elbow ⇒ false), so there
// is no second field answering "how curved is the shaft".
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
    angle: number; // DEGREES, clockwise, y-down — matches SVG rotate()
    index: string; // fractional-index z-order string
    // '' on the infinite canvas; when set, x/y are RELATIVE to that frame's origin.
    frameId: string;
    // A JSON `["id",…]` string like `points`, so every stored field stays a scalar.
    commentCardIds: string;
    opacity: number; // 0..100
    locked: boolean;
    strokeColor: string;
    strokeWidth: number;
    strokeStyle: StrokeStyle;
};

// A serialized Fill — paint + hatch style (see fill.ts): a JSON scalar, '' or malformed ⇒ the
// transparent solid fill.
type Fillable = { fill: string };

// Everything roughjs draws by hand. Image and rich text are DOM boxes, so they carry neither (a stored
// field nothing reads is drift — the same rule that keeps `corners` off the ellipse).
type Sketched = { roughness: number; seed: number };

export type VectorRectangleElement = VectorElementBase & Fillable & Sketched & { type: 'rectangle'; corners: Corners };
export type VectorDiamondElement = VectorElementBase & Fillable & Sketched & { type: 'diamond'; corners: Corners };
// An ellipse has no corners to treat, so it carries no `corners` field; the panel hides the row
// through the kind's capabilities.
export type VectorEllipseElement = VectorElementBase & Fillable & Sketched & { type: 'ellipse' };

// The roughjs-drawn closed shapes.
export type VectorShapeElement = VectorRectangleElement | VectorDiamondElement | VectorEllipseElement;

export type VectorImageElement = VectorElementBase & {
    type: 'image';
    mediaName: string; // filename in the container's media/ folder, NEVER a dataURL
    corners: Corners;
    objectFit: ObjectFit; // → preserveAspectRatio none / xMidYMid meet / xMidYMid slice
};

// The one text kind: TipTap HTML in a box, styled by its own typography fields.
// `strokeColor`/`strokeWidth`/`strokeStyle` are its border, `fill` its box background. A hachured text
// box is not a thing, so its renderer paints the fill's paint half and ignores the hatch style
// (capabilities.fillStyle: false) — the stored field is the same one every fillable kind carries.
export type VectorRichTextElement = VectorElementBase &
    Fillable & {
        type: 'richtext';
        html: string;
        corners: Corners;
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
        padding: number; // px inset between the box edge and the text; the box keeps its stored size
    };

// What an arrow endpoint may dock to: the closed shapes plus the two DOM boxes, whose outline is the
// rounded rect their `corners` describes. The RUNTIME answer is the registry's `bindable` capability
// (isBindable in kinds/index.ts) — this union is its type-level face, and the registry test pins the two
// against each other so neither can grow without the other.
export type VectorBindableElement = VectorShapeElement | VectorRichTextElement | VectorImageElement;

// Freehand strokes and (poly)lines. `points` is a JSON `[[x,y],…]` string in scene units RELATIVE
// to (x,y); the point bbox's min corner is ALWAYS (0,0) (normalizeLinear owns that invariant).
export type VectorLinearElement = VectorElementBase &
    Fillable &
    Sketched & {
        type: 'freedraw' | 'line';
        points: string;
        roundness: Roundness; // line: 'round' = roughjs curve through the vertices. freedraw ignores it.
        // Per-point pen pressure (freedraw only; a line always carries '' + simulate). A JSON `[p0,…]` string
        // aligned by INDEX with `points`, '' = none. `simulatePressure:false` + a matching pressures array feeds
        // perfect-freehand the real per-point widths (Excalidraw's model); the default `simulatePressure:true`
        // (and/or '') reproduces the velocity-simulated stroke. Pressure rides this SEPARATE field, never inside
        // `points` — read-vector re-serializes points as 2-tuples and would strip a 3rd element.
        pressures: string;
        simulatePressure: boolean;
    };

// An arrow is a line (points + roundness) plus heads, forward bindings, and an optional label. Its own
// exclusive `type` keeps the discriminated union clean — `el.type === 'arrow'` narrows straight to the
// arrow fields. `startBinding`/`endBinding` are a JSON `{"elementId","fixedPoint":[fx,fy]}` string or ''
// when unbound (parseBinding/serializeBinding); the reverse index is derived, never stored.
export type VectorArrowElement = VectorElementBase &
    Sketched & {
        type: 'arrow';
        points: string;
        roundness: Roundness;
        // Elbow ("snake") arrow: store only this flag + the two endpoints (points) + bindings; the orthogonal
        // route is DERIVED on every read/render (elbowRoute), never stored. An elbow arrow pins angle 0 (its
        // route lives in the unrotated local frame — the reader forces it). `roundness` is ignored while true.
        elbow: boolean;
        // Pinned route segments (Excalidraw's fixedSegments), '' when none. NON-empty flips the elbow arrow
        // into STORED-POLYLINE mode: `points` then holds the full routed polyline (not just the two endpoints)
        // and the incremental editors in elbow-pins.ts mutate it — the A* router never runs on a pinned arrow.
        // The string is a JSON envelope `{"segments":[{index,start,end},…],"startIsSpecial","endIsSpecial"}`:
        // each pin keys `points[index-1]→points[index]` (Excalidraw's identity), start/end are LOCAL copies of
        // those two vertices (self-describing for validation/resize, always re-derived from the polyline), and
        // the isSpecial flags mark a synthetic L-jog point after start / before end. Ignored on a straight arrow.
        fixedSegments: string;
        startArrowhead: Arrowhead;
        endArrowhead: Arrowhead;
        startBinding: string;
        endBinding: string;
        text: string; // the optional label; '' = no label — the last plain-text path on the canvas
        fontSize: number;
        fontFamily: string;
        labelWidth: number; // client-measured, the sole width source
    };

export type VectorElement =
    | VectorShapeElement
    | VectorImageElement
    | VectorRichTextElement
    | VectorLinearElement
    | VectorArrowElement;

// The element type a `type` key materializes as, used to narrow the registry per kind. Keyed by
// MEMBERSHIP rather than `Extract<VectorElement, { type: K }>`, because freedraw and line share one
// element type whose `type` is the pair — Extract would match neither.
type OfType<T, K> = T extends { type: infer U } ? (K extends U ? T : never) : never;
export type ElementOfType<K extends VectorElementType> = OfType<VectorElement, K>;

// A forward binding: an anchor as a proportion (fixedPoint) of the target shape's local w/h, so the
// anchor follows the shape by construction. Not clamped on write; consumers clamp to [0,1] on read.
type Binding = { elementId: string; fixedPoint: [number, number] };

// One pinned polyline segment (Excalidraw's FixedSegment). `index` is the identity — it keys
// `points[index-1]→points[index]`; `start`/`end` are LOCAL copies of those two vertices (always
// axis-aligned: they share exactly one coordinate). Every writer rebuilds start/end from the
// post-normalization polyline, so the copies never drift from the index.
export type FixedSegment = { index: number; start: [number, number]; end: [number, number] };

// The parsed fixedSegments envelope: the pins plus the two synthetic-point markers. A pinned elbow
// arrow's whole pin state, decoded from the one JSON scalar.
type ParsedFixedSegments = { segments: FixedSegment[]; startIsSpecial: boolean; endIsSpecial: boolean };

export type VectorMeta = { background: string; gridSize: number };

export type VectorScene = { elements: VectorElement[]; frames: VectorFrame[]; meta: VectorMeta };

// The base half of the write/read whitelist. Each kind adds its own; the union (ELEMENT_FIELDS) is
// assembled from the registry in kinds/index.ts.
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
    'locked',
    'strokeColor',
    'strokeWidth',
    'strokeStyle',
] as const;

export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_FAMILY = 'Excalifont';
export const DEFAULT_FILL_STYLE: FillStyle = 'solid';
export const DEFAULT_CORNERS: Corners = 'curved';
export const DEFAULT_OBJECT_FIT: ObjectFit = 'contain';
// Freedraw draws sharp (Excalidraw stores freedraw roundness null); the reader also falls back to this
// for any linear element (line/arrow) missing the field, so stored elements keep their meaning.
export const DEFAULT_LINEAR_ROUNDNESS: Roundness = 'sharp';
// A new line curves by default (Excalidraw's currentItemRoundness defaults to 'round', and newLinearElement
// reads it) — distinct from freedraw's sharp default, hence its own constant.
export const DEFAULT_LINE_ROUNDNESS: Roundness = 'round';
// Arrows curve by default (Excalidraw parity); the read fallback stays sharp so stored
// arrows keep their meaning.
const DEFAULT_ARROW_ROUNDNESS: Roundness = 'round';

// Canvas-level defaults (the `meta` root).
export const DEFAULT_SCENE_META: VectorMeta = { background: 'transparent', gridSize: 20 };

// Shared element defaults, adopted from Excalidraw's DEFAULT_ELEMENT_PROPS.
export const DEFAULT_ELEMENT_PROPS = {
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    strokeStyle: 'solid',
    opacity: 100,
    locked: false,
    frameId: '',
    commentCardIds: '',
} satisfies Pick<
    VectorElementBase,
    'strokeColor' | 'strokeWidth' | 'strokeStyle' | 'opacity' | 'locked' | 'frameId' | 'commentCardIds'
>;

// roughjs tuning, on the six sketched kinds only.
export const DEFAULT_SKETCH_PROPS = { roughness: 1, seed: 0 };

// Rich-text defaults beyond the host's style table: the typography a fresh box starts in, and the
// fallback a corrupt stored value degrades to.
export const DEFAULT_RICHTEXT_PROPS = {
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'left',
    verticalAlign: 'top',
    letterSpacing: 0,
    lineHeight: 1.2,
    padding: 0,
} satisfies Pick<
    VectorRichTextElement,
    | 'fontWeight'
    | 'fontStyle'
    | 'textDecoration'
    | 'textAlign'
    | 'verticalAlign'
    | 'letterSpacing'
    | 'lineHeight'
    | 'padding'
>;

// Arrow-only defaults. Plain arrow, head on the end only, unbound, no label — Excalidraw's
// currentItem defaults.
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

// Shared line-width presets — the ONE source for the thin/medium/bold vocabulary, consumed by both
// the vector panel (strokeWidth, scene-px) and the slides panel (borderWidth, slide-units ≡ scene-px).
// The Excalidraw constants (1/2/4). Data-driven: growing to more weights is an array edit, no UI
// change. Values are Select strings (MergedSelect is string-typed, like sibling ROUGHNESS_OPTIONS);
// consumers parse them back to the literal numeric width with Number().
export const STROKE_WIDTH_OPTIONS: { value: string; label: string }[] = [
    { value: '1', label: 'Thin' },
    { value: '2', label: 'Medium' },
    { value: '4', label: 'Bold' },
];

// Read a property off a parsed-JSON object without a cast (Reflect.get is typed to accept any object).
// The one idiom every decoder in the vector model uses.
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

// The linear family (freedraw / line / arrow) — the elements carrying a `points` string. One narrowing
// predicate so `.points`/`.roundness` access has a single owner as the family grows.
export function isLinearElement(el: VectorElement): el is VectorLinearElement | VectorArrowElement {
    return el.type === 'freedraw' || el.type === 'line' || el.type === 'arrow';
}

// A binding is a JSON `{"elementId","fixedPoint":[fx,fy]}` string, or '' when unbound. parseBinding is
// lenient on the ratio range (a shrunk shape can push fixedPoint outside [0,1]; consumers clamp on use).
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

// Decode the fixedSegments envelope, dropping anything malformed: each pin needs an integer index and a
// finite axis-aligned start/end (sharing exactly one coordinate, not degenerate). A '' or unusable string
// ⇒ no pins. Lenient like parseBinding — a corrupt entry can't wedge the arrow, and the scene never throws
// over a bad peer write. Index-less legacy arrays (the old geometric keying) decode to no pins.
export function parseFixedSegments(s: string): ParsedFixedSegments {
    const empty: ParsedFixedSegments = { segments: [], startIsSpecial: false, endIsSpecial: false };
    if (s === '') return empty;
    let raw: unknown;
    try {
        raw = JSON.parse(s);
    } catch {
        return empty;
    }
    // Envelope form only — a bare array is legacy and dropped.
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
    // Exactly one axis shared, and the segment has length (a point is not a segment).
    if (horizontal === vertical) return null;
    return { index, start: s, end: e };
}

function pairOf(v: unknown): [number, number] | null {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [a, b] = v;
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return [a, b];
}

// Encode pins back to the envelope scalar. '' when there are no pins (⇒ the arrow returns to derived mode).
export function serializeFixedSegments(parsed: ParsedFixedSegments): string {
    if (parsed.segments.length === 0) return '';
    return JSON.stringify({
        segments: parsed.segments.map((s) => ({ index: s.index, start: s.start, end: s.end })),
        startIsSpecial: parsed.startIsSpecial,
        endIsSpecial: parsed.endIsSpecial,
    });
}

// The reverse index the forward bindings imply: shape id → the arrows bound to it, either end. Derived
// in memory (never stored) so there is no two-element write to keep consistent. An arrow bound to
// one shape at both ends lists once.
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

// The 3-way shape a panel shows for an arrow, derived from its stored `elbow` + `roundness` (the
// UI unit's Arrow-type row). elbow wins; otherwise round shaft ⇒ 'curved', sharp shaft ⇒ 'sharp'.
export function arrowShapeOf(el: VectorArrowElement): ArrowShape {
    return el.elbow ? 'elbow' : el.roundness === 'round' ? 'curved' : 'sharp';
}

// The stored fields a chosen shape writes back: 'elbow' sets only the flag and leaves roundness
// untouched — for an elbow it is the CORNER style (sharp bends vs radius-16 arcs), a separate Edges row,
// not the shaft curve — so the write must preserve whatever corner style the element already carries;
// 'curved'/'sharp' clear the flag and pick the shaft roundness. One owner so the panel never re-derives.
export function arrowShapeFields(shape: ArrowShape): { elbow: boolean; roundness?: Roundness } {
    if (shape === 'elbow') return { elbow: true };
    return { elbow: false, roundness: shape === 'curved' ? 'round' : 'sharp' };
}
