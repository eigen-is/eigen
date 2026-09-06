import {
    type Box,
    baseDefaultsFor,
    ELEMENT_KINDS,
    followBindings,
    type StyleDefaults,
    storedFields,
    type VectorArrowElement,
    type VectorElement,
    type VectorElementBase,
    type VectorElementType,
    type VectorImageElement,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import * as Y from 'yjs';

// What the two canvas builders share. deck-build.ts and vector-build.ts write the same element
// records into the same Y.Doc shape, so the anchor-side order, the zero box and the PRNG live here
// once — three copies drifting apart is three demos that no longer reseed identically.

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

// Side-midpoint order matches shapeAnchorPoints (right, bottom, left, top).
export const SIDE_INDEX: Record<CanvasSide, number> = { right: 0, bottom: 1, left: 2, top: 3 };

// normalizeLinear rebases a route onto its own bounds, so the box it starts from is empty.
export const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0, angle: 0 } as const;

// One element/frame record → its Y.Map, through the shared stored-field filter so a spec-only key can
// never reach the doc.
export function toYMap(source: object, fields: readonly string[]): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    for (const [field, value] of storedFields(source, fields)) map.set(field, value);
    return map;
}

// The base every element shares, under the KIND's own overrides — the same table the apps create with,
// so a seeded image or text box arrives unframed rather than wearing the shared 2px ink border.
export function baseElement(
    type: VectorElementType,
    id: string,
): Omit<VectorElementBase, 'type' | 'x' | 'y' | 'width' | 'height' | 'angle'> {
    return { ...baseDefaultsFor(type), id, index: '' };
}

// What a builder supplies on top of the kind's defaults: its box, plus whatever it overrides. `id` and
// `type` are the factory's own, so a caller cannot make an element the registry would not recognise.
type ElementFields<T extends VectorElement> = Omit<Partial<T>, 'id' | 'type'> & Box;

// The two kinds both demos write, built the way the editor's own addElement builds them: shared base,
// the kind's defaults under the HOST's style table, then the caller's box and overrides.
export function richTextElement(
    id: string,
    style: StyleDefaults,
    fields: ElementFields<VectorRichTextElement>,
): VectorRichTextElement {
    return { ...baseElement('richtext', id), ...ELEMENT_KINDS.richtext.defaults(style), type: 'richtext', ...fields };
}

export function imageElement(
    id: string,
    style: StyleDefaults,
    fields: ElementFields<VectorImageElement>,
): VectorImageElement {
    return { ...baseElement('image', id), ...ELEMENT_KINDS.image.defaults(style), type: 'image', ...fields };
}

// Settle a bound arrow's endpoints exactly where the editor would leave them at rest, keeping the
// patch only when it moved anything. Both builders dock arrows onto shapes, so the follow-and-copy
// pass is theirs jointly.
export function settleEndpoints(arrow: VectorArrowElement, byId: Map<string, VectorElement>): void {
    const patch = followBindings(arrow, byId);
    if (!patch) return;
    arrow.x = patch.x;
    arrow.y = patch.y;
    arrow.width = patch.width;
    arrow.height = patch.height;
    arrow.points = patch.points;
    arrow.fixedSegments = patch.fixedSegments;
}

// mulberry32 — a tiny deterministic PRNG, one draw per element (matches addElement's seed range).
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b_79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}
