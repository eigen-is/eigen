// Selection state + the two pure queries the canvas pointer loop needs: top-most hit and the
// marquee "contain" test. Chrome (ObjectTransform vs plain union ring) is chosen by the canvas
// from selectedIds; group move/nudge/delete apply to the whole set.

import { type Bounds, getElementBounds, hitTestElement, type Point, type VectorElement } from '@workspace/lib/vector';
import { useCallback, useState } from 'react';

// Top-most element under a scene point — `ordered` is back-to-front, so scan in reverse.
export function hitTestTopmost(ordered: VectorElement[], point: Point): string | null {
    for (let i = ordered.length - 1; i >= 0; i--) {
        if (hitTestElement(ordered[i], point)) return ordered[i].id;
    }
    return null;
}

// Marquee "contain" rule: an element is picked only when its rotated AABB is fully inside the
// marquee bounds (Excalidraw's default). Stroke-width inflation is optional polish, skipped here.
export function marqueeContain(ordered: VectorElement[], marquee: Bounds): string[] {
    const ids: string[] = [];
    for (const el of ordered) {
        const b = getElementBounds(el);
        if (b.minX >= marquee.minX && b.minY >= marquee.minY && b.maxX <= marquee.maxX && b.maxY <= marquee.maxY) {
            ids.push(el.id);
        }
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
