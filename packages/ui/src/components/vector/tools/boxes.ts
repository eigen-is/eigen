// The three conversions between an element, its Box (what ObjectTransform and the snapper speak) and
// its Bounds (what the geometry helpers return). Here rather than in the canvas component so the tool
// modules and the clipboard hook don't import from the component that renders them.

import type { Bounds, Box, VectorElement } from '@workspace/lib/vector';

export function elementBox(el: VectorElement): Box {
    return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle };
}

export function boundsToBox(b: Bounds): Box {
    return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, angle: 0 };
}

export function boxToBounds(b: Box): Bounds {
    return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
}
