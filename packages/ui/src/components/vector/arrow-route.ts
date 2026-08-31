// The derived orthogonal route of an elbow arrow, for the canvas' own callers (hit-testing, bounds,
// label placement, rendering). It mirrors the private helper `scene-to-svg` uses, so the live canvas
// resolves an elbow arrow's bends exactly as previews/exports do: only an elbow arrow with scene context
// (byId) gets a route; every other element — and an elbow arrow with no map — falls back to its stored
// two endpoints. Making the route come from ONE helper means no callsite can silently forget it and
// degrade an elbow arrow back to a straight line.

import { elbowRoute, type Point, type VectorElement } from '@workspace/lib/vector';

export function arrowRouteOf(el: VectorElement, byId?: Map<string, VectorElement>): Point[] | undefined {
    return el.type === 'arrow' && el.elbow && byId ? elbowRoute(el, byId) : undefined;
}
