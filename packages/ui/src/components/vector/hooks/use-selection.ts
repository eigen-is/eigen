// Selection state + the two pure queries the canvas pointer loop needs: top-most hit and the
// marquee "contain" test. Chrome (ObjectTransform vs plain union ring) is chosen by the canvas
// from selectedIds; group move/nudge/delete apply to the whole set.

import {
    arrowRoute,
    type Bounds,
    elementBounds,
    hitTestElement,
    type MarqueeMode,
    marqueeHits,
    type Point,
    type VectorElement,
} from '@workspace/lib/vector';
import { useCallback, useState } from 'react';

// Hit tolerance in screen px (Excalidraw's DEFAULT_COLLISION_THRESHOLD); divided by zoom so a line's
// grab radius is a constant on-screen distance at any zoom.
const HIT_THRESHOLD_SCREEN = 8;

// Top-most element under a scene point — `ordered` is back-to-front, so scan in reverse. `byId` lets an
// elbow arrow be hit on its DERIVED route (its bends spill past the stored 2-endpoint line), not the
// straight segment; arrowRoute computes it only for elbow arrows.
export function hitTestTopmost(
    ordered: VectorElement[],
    point: Point,
    zoom: number,
    byId?: Map<string, VectorElement>,
): string | null {
    const threshold = HIT_THRESHOLD_SCREEN / zoom;
    for (let i = ordered.length - 1; i >= 0; i--) {
        if (hitTestElement(ordered[i], point, threshold, arrowRoute(ordered[i], byId))) return ordered[i].id;
    }
    return null;
}

// Marquee selection under the shared direction-mode rule (U6c): `mode` picks contain vs intersect;
// each element's arrow-aware rotated AABB (a label overhang counts, R3.6; an elbow arrow's route bbox
// via `byId`) is tested against the marquee bounds by the shared geometry helper.
export function marqueeSelect(
    ordered: VectorElement[],
    marquee: Bounds,
    mode: MarqueeMode,
    byId?: Map<string, VectorElement>,
): string[] {
    const ids: string[] = [];
    for (const el of ordered) {
        if (marqueeHits(elementBounds(el, arrowRoute(el, byId)), marquee, mode)) ids.push(el.id);
    }
    return ids;
}

export function useSelection() {
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    const toggle = useCallback(
        (id: string) => setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])),
        [],
    );

    return { selectedIds, setSelectedIds, toggle };
}
