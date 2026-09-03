// Shape drag-create geometry — the box math and the live preview element the canvas draws while a
// rectangle/diamond/ellipse is being dragged out. Pulled out of canvas-editor.tsx (the canvas only
// dispatches) alongside the other gesture modules (line.ts, freedraw.ts, eraser.ts).

import {
    type Box,
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    VECTOR_STYLE_DEFAULTS,
    type VectorElement,
} from '@workspace/lib/vector';

const CREATING_ID = '__creating__';

export type CreatingState = { type: 'rectangle' | 'diamond' | 'ellipse'; seed: number; box: Box };

// Axis-aligned box from two corner points (also the marquee rect); direction is dropped.
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Box {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), angle: 0 };
}

// Drag-create box: min-corner + extent, or centered on the start point when Alt is held.
export function newShapeBox(sx: number, sy: number, dx: number, dy: number, fromCenter: boolean): Box {
    if (fromCenter) {
        return {
            x: sx - Math.abs(dx),
            y: sy - Math.abs(dy),
            width: Math.abs(dx) * 2,
            height: Math.abs(dy) * 2,
            angle: 0,
        };
    }
    return normalizeRect(sx, sy, sx + dx, sy + dy);
}

export function creatingElement(c: CreatingState): VectorElement {
    const box = {
        id: CREATING_ID,
        x: c.box.x,
        y: c.box.y,
        width: c.box.width,
        height: c.box.height,
        angle: 0,
        ...DEFAULT_ELEMENT_PROPS,
        index: 'a0',
    };
    // The preview takes its style from the same kind defaults the committed element will (addElement),
    // so the two can't drift; only the gesture's seed carries over. One branch per kind, because an
    // ellipse has no corners to treat and the field is not part of its model.
    if (c.type === 'ellipse') {
        return { ...box, ...ELEMENT_KINDS.ellipse.defaults(VECTOR_STYLE_DEFAULTS), type: 'ellipse', seed: c.seed };
    }
    if (c.type === 'diamond') {
        return { ...box, ...ELEMENT_KINDS.diamond.defaults(VECTOR_STYLE_DEFAULTS), type: 'diamond', seed: c.seed };
    }
    return { ...box, ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS), type: 'rectangle', seed: c.seed };
}
