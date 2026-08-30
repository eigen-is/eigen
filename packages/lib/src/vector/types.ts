// The eigen|vector> element model. React-free shared core (the packages/lib/src/sheets
// precedent). Element shape adopted from Excalidraw's `_ExcalidrawElementBase`, trimmed to
// what Eigen's Yjs CRDT needs: no tombstones, no version/versionNonce, no groupIds, no
// points (freehand/line/arrow are additive later units).

export type VectorElementType = 'rectangle' | 'diamond' | 'ellipse' | 'text' | 'image' | 'freedraw' | 'line';

// The runtime value lists are the single source; the union types derive from them, so a grown
// list and its type can never drift. read-vector's validators consume the same arrays.
export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const;
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const ROUNDNESS = ['sharp', 'round'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;

export type FillStyle = (typeof FILL_STYLES)[number];
export type StrokeStyle = (typeof STROKE_STYLES)[number];
export type Roundness = (typeof ROUNDNESS)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];

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
// to (x,y); the point bbox's min corner is ALWAYS (0,0) (normalizeLinear owns that invariant). Shaped so 'arrow'
// extends it additively in Phase 3 — no arrow fields here yet.
export type VectorLinearElement = VectorElementBase & {
    type: 'freedraw' | 'line';
    points: string;
    roundness: Roundness; // line: 'round' = roughjs curve through the vertices, 'sharp' = linearPath. freedraw ignores it.
};

export type VectorElement = VectorShapeElement | VectorTextElement | VectorImageElement | VectorLinearElement;

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
        v === 'line'
    );
}

// The linear family (freedraw / line, and Phase 3's arrow) — the elements carrying a `points` string.
// One narrowing predicate so `.points`/`.roundness` access has a single owner as the family grows.
export function isLinearElement(el: VectorElement): el is VectorLinearElement {
    return el.type === 'freedraw' || el.type === 'line';
}

// A fill is absent when the color is empty or the 'transparent' sentinel (the slides
// borderColor idiom). Kept simple — v1 colors come from the ColorPicker (solid hex +
// a 'transparent' sentinel), not partial-alpha strings.
export function isTransparent(color: string): boolean {
    return color === '' || color === 'transparent';
}
