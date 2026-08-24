// Selection state + the two pure queries the canvas pointer loop needs: top-most hit and the
// marquee "contain" test. Chrome (ObjectTransform vs plain union ring) is chosen by the canvas
// from selectedIds; group move/nudge/delete apply to the whole set.

import {
    type Bounds,
    getElementBounds,
    hitTestElement,
    type MarqueeMode,
    marqueeHits,
    type Point,
    type VectorElement,
} from '@workspace/lib/vector';
import { useCallback, useState } from 'react';

// Top-most element under a scene point — `ordered` is back-to-front, so scan in reverse.
export function hitTestTopmost(ordered: VectorElement[], point: Point): string | null {
    for (let i = ordered.length - 1; i >= 0; i--) {
        if (hitTestElement(ordered[i], point)) return ordered[i].id;
    }
    return null;
}

// Marquee selection under the shared direction-mode rule (U6c): `mode` picks contain vs intersect;
// each element's rotated AABB is tested against the marquee bounds by the shared geometry helper.
export function marqueeSelect(ordered: VectorElement[], marquee: Bounds, mode: MarqueeMode): string[] {
    const ids: string[] = [];
    for (const el of ordered) {
        if (marqueeHits(getElementBounds(el), marquee, mode)) ids.push(el.id);
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
