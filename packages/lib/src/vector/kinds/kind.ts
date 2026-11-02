// The kind contract: what each element type tells the engine, so the engine can treat every kind the same way. A kind
// says what a new element looks like, how a stored one is validated, what it can do, where its edge is, how it draws
// and what it adds to search. A new kind is a new VectorElementType, the kind's own module and a registry entry, and
// nothing else in the engine changes.

import { serializeFill, TRANSPARENT_FILL } from '../fill';
import type { Bounds, Point } from '../geometry';
import { boxCenter, getElementBounds, rotatePoint } from '../geometry';
import type { OutlineShape } from '../outline';
import { EMPTY_OUTLINE } from '../outline';
import type { Corners, TextProps, VectorElement, VectorElementBase } from '../types';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_SHAPE_TEXT_PROPS, prop } from '../types';
import type { YMapLike } from './read-fields';
import { fillField, fontFamily } from './read-fields';
import { readTextual } from './textual';

// A piece of text an element draws, in an EIGEN_FONTS family.
type FontRun = { family: string; text: string };

// What a host's new elements look like. Vector draws rough and hatched in Excalifont, and Slides flat and solid in
// Inter. Each app has one table, and no kind forks it.
export type StyleDefaults = {
    strokeColor: string;
    strokeWidth: number;
    // A serialized Fill, which holds the hatch style as well as the paint.
    fill: string;
    roughness: number;
    corners: Corners;
    fontFamily: string;
    fontSize: number;
    color: string;
};

// What a kind supports. The panel, the tools and the binding code read these instead of switching on `type`.
// `creation: 'none'` keeps a kind off the toolbar, as an image arrives by upload. Each entry answers a question
// some code asks, because a capability nothing reads would drift from the code that does the work.
export type Capabilities = {
    // Whether the kind paints a Fill at all. On a line it depends on the shape, since an open stroke has nothing
    // to fill, so read it through capabilitiesOf(el) and not off this table.
    fill: boolean;
    // Whether the renderer draws the hatch style of that fill. An arrow's fill is its arrowheads', so it hatches
    // nothing.
    fillStyle: boolean;
    // Whether the kind's renderer honors the dash style of that stroke. A freehand stroke is a filled
    // outline rather than a drawn line, so dashes mean nothing to it.
    strokeStyle: boolean;
    corners: boolean;
    // Whether the user picks how the line curves, in the Edges row. A drawn line offers it. A freehand stroke does
    // not, because its roundness is how it is drawn and not a style.
    edges: boolean;
    // Whether the stroke may be turned off, with a None swatch in the Stroke color row. That holds where the element
    // still shows something without it, such as a shape's fill, an image's pixels or a text box's text. It doesn't
    // follow from `fill`: a closed line fills but is still its stroke, and an image shows pixels and not a Fill.
    strokeOptional: boolean;
    bindable: boolean;
    // Whether the element holds rich text that the editor, the panel and the renderer act on.
    text: boolean;
    // The rough shape the elbow router reads to pick the side an arrow leaves by, instead of the exact outline. A
    // new kind an arrow binds to picks one of the three. A kind no arrow binds to declares none.
    silhouette?: 'box' | 'diamond' | 'ellipse';
    creation: 'box' | 'polyline' | 'freedraw' | 'none';
};

// What a box shape supports, such as a rectangle: a hatched fill, a dashed border it may drop, corners, docking, text
// and a tool that drags it out. Each box shape states only where it differs, such as an ellipse, which has no corners.
export const BOX_CAPABILITIES: Capabilities = {
    fill: true,
    fillStyle: true,
    strokeStyle: true,
    corners: true,
    edges: false,
    strokeOptional: true,
    bindable: true,
    text: true,
    silhouette: 'box',
    creation: 'box',
};

// The stored fill and text of a box shape, each validated. A corrupt text field reads as `props`.
export function readBoxShape(src: YMapLike, props: TextProps = DEFAULT_SHAPE_TEXT_PROPS) {
    return { fill: fillField(src.get('fill')), ...readTextual(src, props) };
}

// The base fields a kind may start a new element with other than the shared table's value.
type BasePaintDefaults = Partial<Pick<VectorElementBase, 'strokeColor' | 'strokeWidth' | 'strokeStyle'>>;

type RenderContext = {
    resolveMedia?: (mediaName: string) => string | null;
    // An elbow arrow's derived route; without it the arrow falls back to its stored endpoints.
    route?: Point[];
};

// SVG for everything drawn, and HTML for rich text, which the live canvas and the server mount as a div.
// elementToSvg wraps that HTML in a foreignObject where it needs SVG. The html arm's `svg` is the backdrop painted
// behind the div, and empty when the box paints neither fill nor border.
export type RenderOutput = { svg: string } | { html: string; style: string; svg: string };

// A kind's own stored fields: its element without the base every kind shares. The type distributes over a union,
// so the generic registry lookup gets every member's fields and not only the keys they share.
type KindFields<T extends VectorElement> = T extends VectorElement ? Omit<T, keyof VectorElementBase> : never;

type KindSpec<T extends VectorElement> = {
    type: T['type'];
    is(el: VectorElement): el is T;
    capabilities: Capabilities;
    defaults(style: StyleDefaults): KindFields<T>;
    // Overrides of the shared base defaults for a new element of this kind. An image, for example, uses its stroke
    // as a border, and a new one paints none until the user picks a color. Omit where the base table answers.
    baseDefaults?: BasePaintDefaults;
    // Capabilities that depend on the element and not only its kind, laid over the static table. Omit where every
    // element of the kind answers the same.
    capabilitiesOf?(el: T): Partial<Capabilities>;
    read(src: YMapLike, base: VectorElementBase): T | null;
    // Omit for the default, the turned box. A routed arrow, for example, spills past its box.
    bounds?(el: T, route?: Point[]): Bounds;
    hitTest(el: T, point: Point, threshold: number, route?: Point[]): boolean;
    // In the element's unrotated scene frame, which includes el.x and el.y. Callers rotate it around the element's center.
    outline(el: T, inflate: number): OutlineShape;
    // The dock and snap anchors, in scene space. Omit for the box default.
    anchorPoints?(el: T): Point[];
    // The two lines a straight arrow's bind-time aim projects onto. Omit for the box default.
    aimLines?(el: T): [[Point, Point], [Point, Point]];
    // Draws in the element's local frame, with its origin at the element's top-left. elementToSvg's <g transform> places
    // and rotates it.
    render(el: T, ctx: RenderContext): RenderOutput;
    // Whether this element puts nothing on the page, such as an empty text box, a shape with neither fill nor
    // border, or an image with no picture. The canvas rings such an element while editing, so it stays findable. A
    // kind that always paints something omits this.
    paintsNothing?(el: T): boolean;
    // What the kind contributes to the search index. Omit when it carries no text.
    searchText?(el: T): string;
    // The text this element draws, each run in the EIGEN_FONTS family it draws in. The SVG download embeds the slices
    // these runs need. Omit for the default: the kind's search text in its `fontFamily` field, when it has both.
    fontRuns?(el: T): FontRun[];
    // Convert to shapes: the plain elements that draw what this one draws, in its coordinate space, or none when
    // there is nothing to unpack. Omit where no element of the kind unpacks.
    toShapes?(el: T): VectorElement[];
};

// The registry entry. `defaults` and `read` keep the kind's own element type, so code that names a kind, such as
// `ELEMENT_KINDS.rectangle`, builds a typed element without listing its fields again. Every other method takes the
// union, so a generic `ELEMENT_KINDS[el.type]` call compiles.
export type ElementKind<T extends VectorElement = VectorElement> = {
    type: T['type'];
    fields: readonly string[];
    capabilities: Capabilities;
    // The capabilities of one element: the static table with the kind's overrides for that element. Callers use
    // the registry's capabilitiesOf(el).
    capabilitiesOf(el: VectorElement): Capabilities;
    defaults(style: StyleDefaults): KindFields<T>;
    baseDefaults: BasePaintDefaults;
    read(src: YMapLike, base: VectorElementBase): T | null;
    bounds(el: VectorElement, route?: Point[]): Bounds;
    hitTest(el: VectorElement, point: Point, threshold: number, route?: Point[]): boolean;
    outline(el: VectorElement, inflate: number): OutlineShape;
    anchorPoints(el: VectorElement): Point[];
    aimLines(el: VectorElement): [[Point, Point], [Point, Point]];
    render(el: VectorElement, ctx: RenderContext): RenderOutput;
    paintsNothing(el: VectorElement): boolean;
    searchText(el: VectorElement): string;
    fontRuns(el: VectorElement): FontRun[];
    toShapes(el: VectorElement): VectorElement[];
};

// The dock anchors of anything box-shaped: the midpoints of its right, bottom, left and top edges, turned with
// the element. They are an ellipse's axis ends and a diamond's tips too. The order is Excalidraw's
// getSnapOutlineMidPoint order, so a midpoint snap picks the same side on a tie.
export function boxAnchorPoints(el: VectorElement): Point[] {
    const { x, y, width: w, height: h } = el;
    const center = boxCenter(el);
    return [
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
        { x: x + w / 2, y },
    ].map((p) => rotatePoint(p, center, el.angle));
}

// The default aim lines: the vertical and horizontal center lines, at full length. Excalidraw uses these for
// every shape an arrow binds to except the rectangle, which aims along its shortened corner diagonals.
export function boxAimLines(el: VectorElement): [[Point, Point], [Point, Point]] {
    const { x, y, width: w, height: h } = el;
    const center = boxCenter(el);
    const rotate = (point: Point): Point => rotatePoint(point, center, el.angle);
    return [
        [rotate({ x: x + w / 2, y }), rotate({ x: x + w / 2, y: y + h })],
        [rotate({ x, y: y + h / 2 }), rotate({ x: x + w, y: y + h / 2 })],
    ];
}

// The box a click with the text tool places, in scene units. Both apps share it, because the height is only where
// the box starts: it grows to the first line typed, at the size the app's style table gives.
export const NEW_TEXT_BOX_SIZE = { width: 320, height: 48 };

// The Vector app's style table: rough, cross-hatched, in Excalifont, with curved corners. A new element starts
// unpainted but hatched. The hatch style is part of the fill, so the first color the user picks lands
// cross-hatched.
export const VECTOR_STYLE_DEFAULTS: StyleDefaults = {
    strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
    strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
    fill: serializeFill({ ...TRANSPARENT_FILL, style: 'cross-hatch' }),
    roughness: 1,
    corners: 'curved',
    fontFamily: 'Excalifont',
    fontSize: 20,
    color: DEFAULT_ELEMENT_PROPS.strokeColor,
};

// The deck's style table: flat and solid in Inter, the way a presentation reads. A host's table decides how a new
// element looks, never which kinds exist. A new box starts its text at the top left in both apps.
export const SLIDES_STYLE_DEFAULTS: StyleDefaults = {
    strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
    strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
    fill: serializeFill({ ...TRANSPARENT_FILL, style: 'solid' }),
    roughness: 0,
    corners: 'curved',
    fontFamily: 'Inter',
    fontSize: 48,
    color: '#000000',
};

// Turns a kind's own spec into the registry entry that takes any element. Each method narrows through the kind's
// own guard, so no caller needs a cast. An element of the wrong kind gets an empty answer and never throws while
// the canvas draws.
export function defineKind<T extends VectorElement>(spec: KindSpec<T>): ElementKind<T> {
    // The stored keys beyond the base set, read off `defaults`, so a kind declares them once. Every kind's defaults
    // are pure, so one call when the module loads answers for good.
    const fields = Object.keys(spec.defaults(VECTOR_STYLE_DEFAULTS));
    const hasFont = fields.includes('fontFamily');
    return {
        type: spec.type,
        fields,
        capabilities: spec.capabilities,
        capabilitiesOf: (el) =>
            spec.is(el) && spec.capabilitiesOf
                ? { ...spec.capabilities, ...spec.capabilitiesOf(el) }
                : spec.capabilities,
        defaults: spec.defaults,
        baseDefaults: spec.baseDefaults ?? {},
        read: spec.read,
        bounds: (el, route) => (spec.is(el) && spec.bounds ? spec.bounds(el, route) : getElementBounds(el)),
        hitTest: (el, point, threshold, route) => (spec.is(el) ? spec.hitTest(el, point, threshold, route) : false),
        outline: (el, inflate) => (spec.is(el) ? spec.outline(el, inflate) : EMPTY_OUTLINE),
        anchorPoints: (el) => (spec.is(el) && spec.anchorPoints ? spec.anchorPoints(el) : boxAnchorPoints(el)),
        aimLines: (el) => (spec.is(el) && spec.aimLines ? spec.aimLines(el) : boxAimLines(el)),
        render: (el, ctx) => (spec.is(el) ? spec.render(el, ctx) : { svg: '' }),
        paintsNothing: (el) => (spec.is(el) && spec.paintsNothing ? spec.paintsNothing(el) : false),
        searchText: (el) => (spec.is(el) && spec.searchText ? spec.searchText(el) : ''),
        fontRuns: (el) => {
            if (!spec.is(el)) return [];
            if (spec.fontRuns) return spec.fontRuns(el);
            const text = spec.searchText?.(el);
            return hasFont && text ? [{ family: fontFamily(prop(el, 'fontFamily')), text }] : [];
        },
        toShapes: (el) => (spec.is(el) && spec.toShapes ? spec.toShapes(el) : []),
    };
}
