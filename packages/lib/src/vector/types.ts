// The eigen|vector> element model. React-free shared core (the packages/lib/src/sheets
// precedent). Element shape adopted from Excalidraw's `_ExcalidrawElementBase`, trimmed to
// what Eigen's Yjs CRDT needs: no tombstones, no version/versionNonce, no groupIds, no
// points (freehand/line/arrow are additive later units).

export type VectorElementType = 'rectangle' | 'diamond' | 'ellipse' | 'text' | 'image' | 'freedraw' | 'line' | 'arrow';

// The runtime value lists are the single source; the union types derive from them, so a grown
// list and its type can never drift. read-vector's validators consume the same arrays.
export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const;
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const ROUNDNESS = ['sharp', 'round'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
// Arrowhead vocabulary (both ends), Excalidraw's trimmed to the shapes we draw. read-vector validates
// against this array; the panel's start/end selects list it (U3c).
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'bar', 'circle'] as const;
// The 3-way arrow-shape vocabulary the panel offers (UA4). It is a DERIVED UI concept, not a stored field:
// 'sharp'/'curved' are the existing `roundness` (sharp linearPath vs round curve shaft), and 'elbow' is the
// one new stored boolean below. Keeping roundness as the single owner of shaft curvature (shared with
// line/freedraw) means existing arrows — which carry only `roundness` — read back unchanged (elbow ⇒ false),
// so there is no reader BC break and no second field answering "how curved is the shaft".
export const ARROW_SHAPES = ['sharp', 'curved', 'elbow'] as const;

export type FillStyle = (typeof FILL_STYLES)[number];
export type StrokeStyle = (typeof STROKE_STYLES)[number];
export type Roundness = (typeof ROUNDNESS)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type Arrowhead = (typeof ARROWHEADS)[number];
export type ArrowShape = (typeof ARROW_SHAPES)[number];

export type VectorElementBase = {
    id: string;
    type: VectorElementType;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number; // DEGREES, clockwise, y-down — matches SVG rotate() and slides `rotation`
    strokeColor: string;
    backgroundColor: string; // fill color; '' or 'transparent' = no fill (see isTransparent)
    fillStyle: FillStyle;
    strokeWidth: number;
    strokeStyle: StrokeStyle;
    roughness: number;
    seed: number; // deterministic roughjs output across renders/peers
    opacity: number; // 0..100
    locked: boolean;
    index: string; // fractional-index z-order string
};

export type VectorShapeElement = VectorElementBase & {
    type: 'rectangle' | 'diamond' | 'ellipse';
    roundness: Roundness;
};

export type VectorTextElement = VectorElementBase & {
    type: 'text';
    text: string;
    fontSize: number;
    fontFamily: string; // an EIGEN_FONTS name; default 'Excalifont'
    textAlign: TextAlign;
    // width/height are CLIENT-MEASURED and authoritative — sceneToSvg never measures text
};

export type VectorImageElement = VectorElementBase & {
    type: 'image';
    mediaName: string; // filename in the container's media/ folder, NEVER a dataURL
};

// Freehand strokes and (poly)lines. `points` is a JSON `[[x,y],…]` string in scene units RELATIVE
// to (x,y); the point bbox's min corner is ALWAYS (0,0) (normalizeLinear owns that invariant).
export type VectorLinearElement = VectorElementBase & {
    type: 'freedraw' | 'line';
    points: string;
    roundness: Roundness; // line: 'round' = roughjs curve through the vertices, 'sharp' = linearPath. freedraw ignores it.
};

// An arrow is a line (points + roundness) plus heads, forward bindings, and an optional label. Its own
// exclusive `type` keeps the discriminated union clean — `el.type === 'arrow'` narrows straight to the
// arrow fields. `startBinding`/`endBinding` are a JSON `{"elementId","fixedPoint":[fx,fy]}` string or ''
// when unbound (parseBinding/serializeBinding); the reverse index is derived, never stored (R3.2).
export type VectorArrowElement = VectorElementBase & {
    type: 'arrow';
    points: string;
    roundness: Roundness;
    // Elbow ("snake") arrow: store only this flag + the two endpoints (points) + bindings; the orthogonal
    // route is DERIVED on every read/render (elbowRoute), never stored. An elbow arrow pins angle 0 (its
    // route lives in the unrotated local frame — the reader forces it). `roundness` is ignored while true.
    elbow: boolean;
    // Pinned route segments (Excalidraw's fixedSegments), '' when none. NON-empty flips the elbow arrow
    // into STORED-POLYLINE mode: `points` then holds the full routed polyline (not just the two endpoints)
    // and the incremental editors in elbow-pins.ts mutate it — the A* router never runs on a pinned arrow
    // (P1). The string is a JSON envelope `{"segments":[{index,start,end},…],"startIsSpecial","endIsSpecial"}`:
    // each pin keys `points[index-1]→points[index]` (Excalidraw's identity), start/end are LOCAL copies of
    // those two vertices (self-describing for validation/resize, always re-derived from the polyline), and
    // the isSpecial flags mark a synthetic L-jog point after start / before end. Ignored on a straight
    // arrow. Old index-less data is dropped by the reader (the feature is unreleased — no BC).
    fixedSegments: string;
    startArrowhead: Arrowhead;
    endArrowhead: Arrowhead;
    startBinding: string;
    endBinding: string;
    text: string; // the optional label; '' = no label
    fontSize: number;
    fontFamily: string;
    labelWidth: number; // client-measured, the sole width source — like text elements' width
};

export type VectorElement =
    | VectorShapeElement
    | VectorTextElement
    | VectorImageElement
    | VectorLinearElement
    | VectorArrowElement;

// A forward binding: an anchor as a proportion (fixedPoint) of the target shape's local w/h, so the
// anchor follows the shape by construction. Not clamped on write; consumers clamp to [0,1] on read.
export type Binding = { elementId: string; fixedPoint: [number, number] };

// One pinned polyline segment (Excalidraw's FixedSegment). `index` is the identity — it keys
// `points[index-1]→points[index]`; `start`/`end` are LOCAL copies of those two vertices (always
// axis-aligned: they share exactly one coordinate). Every writer rebuilds start/end from the
// post-normalization polyline, so the copies never drift from the index.
export type FixedSegment = { index: number; start: [number, number]; end: [number, number] };

// The parsed fixedSegments envelope: the pins plus the two synthetic-point markers (P3). A pinned elbow
// arrow's whole pin state, decoded from the one JSON scalar.
export type ParsedFixedSegments = { segments: FixedSegment[]; startIsSpecial: boolean; endIsSpecial: boolean };

export type VectorMeta = { background: string; gridSize: number };

export type VectorScene = { elements: VectorElement[]; meta: VectorMeta };

// The write/read whitelist, one-for-one with the slides OBJECT_FIELDS idiom. Every
// doc.transact write iterates it; the reader materializes only these keys. Every field is
// a scalar or string — nothing array-valued — so no Y.Array normalization is needed.
export const ELEMENT_FIELDS = [
    'id',
    'type',
    'x',
    'y',
    'width',
    'height',
    'angle',
    'strokeColor',
    'backgroundColor',
    'fillStyle',
    'strokeWidth',
    'strokeStyle',
    'roughness',
    'seed',
    'opacity',
    'locked',
    'index',
    'roundness',
    'points',
    'text',
    'fontSize',
    'fontFamily',
    'textAlign',
    'mediaName',
    'startArrowhead',
    'endArrowhead',
    'startBinding',
    'endBinding',
    'elbow',
    'fixedSegments',
    'labelWidth',
] as const;

export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_FAMILY = 'Excalifont';
export const DEFAULT_SHAPE_ROUNDNESS: Roundness = 'round';
// A drawn line/freedraw is straight by default; the reader falls back to this for a linear element.
export const DEFAULT_LINEAR_ROUNDNESS: Roundness = 'sharp';

// Canvas-level defaults (the `meta` root).
export const DEFAULT_SCENE_META: VectorMeta = { background: 'transparent', gridSize: 20 };

// Shared element defaults, adopted from Excalidraw's DEFAULT_ELEMENT_PROPS.
export const DEFAULT_ELEMENT_PROPS = {
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    locked: false,
} satisfies Pick<
    VectorElementBase,
    'strokeColor' | 'backgroundColor' | 'fillStyle' | 'strokeWidth' | 'strokeStyle' | 'roughness' | 'opacity' | 'locked'
>;

export const DEFAULT_TEXT_PROPS = {
    text: '',
    fontSize: DEFAULT_FONT_SIZE,
    fontFamily: DEFAULT_FONT_FAMILY,
    textAlign: 'left',
} satisfies Pick<VectorTextElement, 'text' | 'fontSize' | 'fontFamily' | 'textAlign'>;

// Arrow-only defaults (label text/fontSize/fontFamily reuse DEFAULT_TEXT_PROPS). Plain arrow, head on
// the end only, unbound, no label — Excalidraw's currentItem defaults.
export const DEFAULT_ARROW_PROPS = {
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding: '',
    elbow: false,
    fixedSegments: '',
    labelWidth: 0,
} satisfies Pick<
    VectorArrowElement,
    'startArrowhead' | 'endArrowhead' | 'startBinding' | 'endBinding' | 'elbow' | 'fixedSegments' | 'labelWidth'
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

export function isVectorElementType(v: unknown): v is VectorElementType {
    return (
        v === 'rectangle' ||
        v === 'diamond' ||
        v === 'ellipse' ||
        v === 'text' ||
        v === 'image' ||
        v === 'freedraw' ||
        v === 'line' ||
        v === 'arrow'
    );
}

// The linear family (freedraw / line / arrow) — the elements carrying a `points` string. One narrowing
// predicate so `.points`/`.roundness` access has a single owner as the family grows.
export function isLinearElement(el: VectorElement): el is VectorLinearElement | VectorArrowElement {
    return el.type === 'freedraw' || el.type === 'line' || el.type === 'arrow';
}

// Bindable targets for an arrow endpoint: the closed shapes only (R3.2). One predicate so every
// consumer — the reader's dangling-binding pass, the follow math, the tool's candidate search — agrees.
export function isBindable(el: VectorElement): el is VectorShapeElement {
    return el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse';
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
    const { elementId, fixedPoint } = raw as { elementId?: unknown; fixedPoint?: unknown };
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
// over a bad peer write. Index-less legacy arrays (the deleted EP-U5 geometric keying) decode to no pins.
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
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { segments?: unknown }).segments)) {
        return empty;
    }
    const { segments, startIsSpecial, endIsSpecial } = raw as {
        segments: unknown[];
        startIsSpecial?: unknown;
        endIsSpecial?: unknown;
    };
    const out: FixedSegment[] = [];
    for (const entry of segments) {
        const seg = fixedSegmentOf(entry);
        if (seg) out.push(seg);
    }
    return {
        segments: out,
        startIsSpecial: startIsSpecial === true,
        endIsSpecial: endIsSpecial === true,
    };
}

function fixedSegmentOf(entry: unknown): FixedSegment | null {
    if (typeof entry !== 'object' || entry === null) return null;
    const { index, start, end } = entry as { index?: unknown; start?: unknown; end?: unknown };
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
// in memory (never stored) so there is no two-element write to keep consistent (R3.2). An arrow bound to
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

// The 3-way shape a panel shows for an arrow, derived from its stored `elbow` + `roundness` (UA4b, the
// UI unit's Arrow-type row). elbow wins; otherwise round shaft ⇒ 'curved', sharp shaft ⇒ 'sharp'.
export function arrowShapeOf(el: VectorArrowElement): ArrowShape {
    return el.elbow ? 'elbow' : el.roundness === 'round' ? 'curved' : 'sharp';
}

// The stored fields a chosen shape writes back (UA4b): 'elbow' sets only the flag and leaves roundness
// untouched — for an elbow it is the CORNER style (sharp bends vs radius-16 arcs), a separate Edges row,
// not the shaft curve — so the write must preserve whatever corner style the element already carries;
// 'curved'/'sharp' clear the flag and pick the shaft roundness. One owner so the panel never re-derives.
export function arrowShapeFields(shape: ArrowShape): { elbow: boolean; roundness?: Roundness } {
    if (shape === 'elbow') return { elbow: true };
    return { elbow: false, roundness: shape === 'curved' ? 'round' : 'sharp' };
}

// A fill is absent when the color is empty or the 'transparent' sentinel (the slides
// borderColor idiom). Kept simple — v1 colors come from the ColorPicker (solid hex +
// a 'transparent' sentinel), not partial-alpha strings.
export function isTransparent(color: string): boolean {
    return color === '' || color === 'transparent';
}
