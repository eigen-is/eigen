// Box drag-create geometry — the box math and the live preview element the canvas draws while a
// rectangle/diamond/ellipse/rich-text box is being dragged out. Pulled out of canvas-editor.tsx (the canvas only
// dispatches) alongside the other gesture modules (line.ts, freedraw.ts, eraser.ts).

import {
    type Box,
    baseDefaultsFor,
    ELEMENT_KINDS,
    type StyleDefaults,
    type VectorElement,
} from '@workspace/lib/vector';
import type { VectorTool } from '../hooks/use-tool';

const CREATING_ID = '__creating__';

// The kinds a box drag creates. The literal tuple is what gives CreatingState a narrow type, so
// creatingElement composes each kind's own element without a cast; `isBoxTool` answers from the
// registry's `creation` capability, and the registry test pins the two against each other.
const BOX_TOOLS = ['rectangle', 'diamond', 'ellipse', 'richtext'] as const;
type BoxTool = (typeof BOX_TOOLS)[number];

export function isBoxTool(tool: VectorTool): tool is BoxTool {
    return tool !== 'select' && tool !== 'eraser' && ELEMENT_KINDS[tool].capabilities.creation === 'box';
}

export type CreatingState = { type: BoxTool; seed: number; box: Box };

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

export function creatingElement(c: CreatingState, style: StyleDefaults): VectorElement {
    const box = {
        id: CREATING_ID,
        x: c.box.x,
        y: c.box.y,
        width: c.box.width,
        height: c.box.height,
        angle: 0,
        // The same base paint the committed element gets (addElement reads the same helper), so a kind
        // whose stroke is a border — rich text — previews unframed instead of popping on release.
        ...baseDefaultsFor(c.type),
        index: 'a0',
    };
    // The preview takes its style from the same kind defaults the committed element will (addElement
    // reads the host's own table), so the two can't drift; only the gesture's seed carries over. One
    // branch per kind because each composes its OWN element type — a union-typed
    // `ELEMENT_KINDS[c.type].defaults()` spread would need a cast — and because rich text is seedless
    // and previews with an outline no committed box has.
    if (c.type === 'ellipse') {
        return { ...box, ...ELEMENT_KINDS.ellipse.defaults(style), type: 'ellipse', seed: c.seed };
    }
    if (c.type === 'diamond') {
        return { ...box, ...ELEMENT_KINDS.diamond.defaults(style), type: 'diamond', seed: c.seed };
    }
    if (c.type === 'richtext') {
        // An empty text box paints nothing, so the drag needs an outline to size against. Preview-only:
        // the committed box keeps the kind's own (transparent) border.
        return {
            ...box,
            ...ELEMENT_KINDS.richtext.defaults(style),
            type: 'richtext',
            strokeColor: style.strokeColor,
            strokeWidth: 1,
            strokeStyle: 'dashed',
        };
    }
    if (c.type === 'rectangle') {
        return { ...box, ...ELEMENT_KINDS.rectangle.defaults(style), type: 'rectangle', seed: c.seed };
    }
    // Exhaustiveness guard: a new box-creation kind brings its own preview branch instead of silently
    // previewing as a rectangle (the kinds test pins BOX_TOOLS to the registry).
    const exhaustive: never = c.type;
    return exhaustive;
}
