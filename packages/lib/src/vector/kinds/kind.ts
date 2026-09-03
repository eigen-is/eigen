// The kind contract. One entry per element type, and everything the engine needs to treat a kind
// generically: what a new one looks like, how a stored one is validated, what it can do, where its edge
// is, how it draws, what it contributes to search. Adding `graph` = add it to VectorElementType, write
// kinds/graph.ts, add one line to kinds/index.ts. Nothing else in the engine changes.
//
// FRAMES: `outline(el, inflate)` works in the element's unrotated SCENE frame (it includes el.x/el.y;
// callers rotate around the element centre). `render(el, ctx)` draws in the element's LOCAL frame
// (origin at its top-left) — elementToSvg's <g transform> is what places and rotates it.

import { type Bounds, boxCenter, getElementBounds, type Point, rotatePoint } from '../geometry';
import type { OutlineShape } from '../outline';
import type { Corners, FillStyle, VectorElement, VectorElementBase } from '../types';

// What a host's new elements look like: vector draws rough and hatched in Excalifont, slides flat and
// solid in Inter. One table per app, not a per-kind fork.
export type StyleDefaults = {
    strokeColor: string;
    strokeWidth: number;
    fill: string; // a serialized Fill
    fillStyle: FillStyle;
    roughness: number;
    corners: Corners;
    fontFamily: string;
    fontSize: number;
    color: string;
};

// What a kind supports. The panel, the tools and the binding code read these instead of switching on
// `type`; `creation: 'none'` keeps a kind off the toolbar (an image arrives by upload, not by drawing).
// One entry per question something actually asks — a capability nothing reads is a second list waiting
// to disagree with the code that does the work.
export type Capabilities = {
    fill: boolean;
    fillStyle: boolean;
    // Also "is this kind drawn by roughjs at all": the sketch paint rows follow it.
    roughness: boolean;
    corners: boolean;
    // The Stroke rows (colour / width / style). True on every kind today: shapes and linear elements
    // draw the stroke, image and rich text use it as their border. It is a capability rather than an
    // ungated panel section so a future kind that paints no stroke has one place to say so.
    stroke: boolean;
    // Whether the stroke may be switched OFF (the Stroke colour row offers a None swatch). True where
    // the element still has a body without it — a shape's fill, an image's pixels, a text box's text.
    // Not derivable from `fill`: a line fills only when its path closes yet IS its stroke, and an
    // image's body is pixels rather than a Fill.
    strokeOptional: boolean;
    // The rich-text typography section (font, weight, alignment, spacing, colour, padding). An arrow's
    // label fonts are NOT this: they are measured client-side through the panel's own label path.
    typography: boolean;
    // The image fit row (`objectFit`).
    objectFit: boolean;
    bindable: boolean;
    // Which family the elbow router's heading heuristics follow — the silhouette, not the exact outline.
    // A new bindable kind picks one of the three instead of adding a branch to elbow-heading.
    silhouette: 'box' | 'diamond' | 'ellipse';
    creation: 'box' | 'polyline' | 'freedraw' | 'none';
};

// The base fields a kind may start a new element with other than the shared table's value.
export type BasePaintDefaults = Partial<Pick<VectorElementBase, 'strokeColor' | 'strokeWidth' | 'strokeStyle'>>;

// A per-element Y.Map, or anything else exposing its `get` (the reader's only requirement).
export type FieldSource = { get(key: string): unknown };

export type RenderContext = {
    resolveMedia?: (mediaName: string) => string | null;
    // An elbow arrow's derived route; without it the arrow falls back to its stored endpoints.
    route?: Point[];
};

// SVG for everything drawn; HTML for rich text, which the live canvas and the server compositor mount as
// a div (elementToSvg wraps it in a foreignObject for the SVG arms).
export type RenderOutput = { svg: string } | { html: string; style: string };

// A kind's OWN stored fields: its element minus the base every kind shares. Distributive, so a
// union-typed T (the generic registry lookup) yields the union of the members' field sets, not the
// handful of keys they happen to share.
type KindFields<T extends VectorElement> = T extends VectorElement ? Omit<T, keyof VectorElementBase> : never;

export type KindSpec<T extends VectorElement> = {
    type: T['type'];
    is(el: VectorElement): el is T;
    // The stored keys BEYOND the base set. ELEMENT_FIELDS is BASE_ELEMENT_FIELDS plus every kind's.
    fields: readonly string[];
    capabilities: Capabilities;
    defaults(style: StyleDefaults): KindFields<T>;
    // Overrides of the shared base defaults for a NEW element of this kind. The DOM-box kinds use the
    // stroke as a BORDER, and a fresh box paints none until the user picks a colour (slides' borderWidth
    // 0, same intent). Omit where the base table already answers.
    baseDefaults?: BasePaintDefaults;
    read(src: FieldSource, base: VectorElementBase): T | null;
    // Omit for the rotated-box default (only a routed arrow spills past its box).
    bounds?(el: T, route?: Point[]): Bounds;
    hitTest(el: T, point: Point, threshold: number, route?: Point[]): boolean;
    outline(el: T, inflate: number): OutlineShape;
    // The four dock anchors in SCENE space, right/bottom/left/top. Omit for the box default.
    anchorPoints?(el: T): Point[];
    // The two lines a straight arrow's bind-time aim projects onto. Omit for the box default.
    aimLines?(el: T): [[Point, Point], [Point, Point]];
    render(el: T, ctx: RenderContext): RenderOutput;
    // What the kind contributes to the search index. Omit when it carries no text.
    searchText?(el: T): string;
};

// The registry entry. `defaults` and `read` keep the kind's own element type, so a consumer that names
// a kind (`ELEMENT_KINDS.richtext`) composes a typed element instead of re-listing its fields; every
// other method takes the union, so a generic `ELEMENT_KINDS[el.type]` dispatch stays callable.
export type ElementKind<T extends VectorElement = VectorElement> = {
    type: T['type'];
    fields: readonly string[];
    capabilities: Capabilities;
    defaults(style: StyleDefaults): KindFields<T>;
    baseDefaults: BasePaintDefaults;
    read(src: FieldSource, base: VectorElementBase): T | null;
    bounds(el: VectorElement, route?: Point[]): Bounds;
    hitTest(el: VectorElement, point: Point, threshold: number, route?: Point[]): boolean;
    outline(el: VectorElement, inflate: number): OutlineShape;
    anchorPoints(el: VectorElement): Point[];
    aimLines(el: VectorElement): [[Point, Point], [Point, Point]];
    render(el: VectorElement, ctx: RenderContext): RenderOutput;
    searchText(el: VectorElement): string;
};

// The empty outline a mis-dispatched element gets: no edge, so nothing docks to it.
const EMPTY_OUTLINE: OutlineShape = { kind: 'polyline', points: [] };

// The dock anchors of anything box-shaped: the right/bottom/left/top edge midpoints, rotated by the
// element's angle. An ellipse's are its axis extremes and a diamond's are its four tips (Excalidraw's
// getDiamondBaseCorners) — the same four points, so no kind overrides this. Excalidraw's
// getSnapOutlineMidPoint order, so a bind-time midpoint snap resolves the same side on a tie.
function boxAnchorPoints(el: VectorElement): Point[] {
    const { x, y, width: w, height: h } = el;
    const center = boxCenter(el);
    return [
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
        { x: x + w / 2, y },
    ].map((p) => rotatePoint(p, center, el.angle));
}

// The default aim lines: the vertical + horizontal centre lines, un-shrunk. Excalidraw uses these for every
// bindable shape except the rectangle, which overrides with its shrunk corner diagonals.
function boxAimLines(el: VectorElement): [[Point, Point], [Point, Point]] {
    const { x, y, width: w, height: h } = el;
    const center = boxCenter(el);
    const rot = (p: Point): Point => rotatePoint(p, center, el.angle);
    return [
        [rot({ x: x + w / 2, y }), rot({ x: x + w / 2, y: y + h })],
        [rot({ x, y: y + h / 2 }), rot({ x: x + w, y: y + h / 2 })],
    ];
}

// Widen a narrow-typed kind into the union-typed registry entry. Each method re-narrows through the
// kind's own guard, so no call site needs a cast and a mis-dispatch degrades quietly instead of
// throwing on a render path.
export function defineKind<T extends VectorElement>(spec: KindSpec<T>): ElementKind<T> {
    return {
        type: spec.type,
        fields: spec.fields,
        capabilities: spec.capabilities,
        defaults: spec.defaults,
        baseDefaults: spec.baseDefaults ?? {},
        read: spec.read,
        bounds: (el, route) => (spec.is(el) && spec.bounds ? spec.bounds(el, route) : getElementBounds(el)),
        hitTest: (el, point, threshold, route) => (spec.is(el) ? spec.hitTest(el, point, threshold, route) : false),
        outline: (el, inflate) => (spec.is(el) ? spec.outline(el, inflate) : EMPTY_OUTLINE),
        anchorPoints: (el) => (spec.is(el) && spec.anchorPoints ? spec.anchorPoints(el) : boxAnchorPoints(el)),
        aimLines: (el) => (spec.is(el) && spec.aimLines ? spec.aimLines(el) : boxAimLines(el)),
        render: (el, ctx) => (spec.is(el) ? spec.render(el, ctx) : { svg: '' }),
        searchText: (el) => (spec.is(el) && spec.searchText ? spec.searchText(el) : ''),
    };
}
