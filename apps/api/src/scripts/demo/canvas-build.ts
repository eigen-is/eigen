// What the two canvas builders share. deck-build.ts and vector-build.ts write the same element
// records into the same Y.Doc shape, so the anchor-side order, the zero box and the PRNG live here
// once — three copies drifting apart is three demos that no longer reseed identically.

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

// Side-midpoint order matches shapeAnchorPoints (right, bottom, left, top).
export const SIDE_INDEX: Record<CanvasSide, number> = { right: 0, bottom: 1, left: 2, top: 3 };

// normalizeLinear rebases a route onto its own bounds, so the box it starts from is empty.
export const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0, angle: 0 } as const;

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
