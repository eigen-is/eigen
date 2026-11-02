// Box drag-create: the box math, what each box tool creates, and the live preview element the canvas draws while a
// shape or a text box is being dragged out. It sits beside the other gesture modules, such as the line and freehand
// ones, so the canvas only dispatches.

import type { Box, NewVectorElement, StyleDefaults, VectorElement } from '@workspace/lib/vector';
import { baseDefaultsFor, ELEMENT_KINDS, textBoxDefaults } from '@workspace/lib/vector';
import type { VectorTool } from '../hooks/use-tool';

const CREATING_ID = '__creating__';

// The tools a box drag creates with: the box kinds, and the Text tool, which drags out a text box. The narrow union
// lets creatingElement compose each element without a cast. `isBoxTool` answers for the kinds from the registry's
// `creation` capability, and the registry test pins the two against each other.
type BoxTool = 'rectangle' | 'diamond' | 'ellipse' | 'text';

export function isBoxTool(tool: VectorTool): tool is BoxTool {
    if (tool === 'text') return true;
    return tool !== 'select' && tool !== 'eraser' && ELEMENT_KINDS[tool].capabilities.creation === 'box';
}

export type CreatingState = { tool: BoxTool; seed: number; box: Box };

// What a box tool creates: the kind it names, or for the Text tool a text box, a rectangle that fits its text.
export function boxToolElement(tool: BoxTool): NewVectorElement {
    return tool === 'text' ? { type: 'rectangle', autoFit: true } : { type: tool };
}

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

// The preview takes its paint and style from the same defaults the committed element gets (addElement reads the
// host's own table), so the two can't drift; only the gesture's seed carries over. One branch per tool because each
// composes its OWN element type: a union-typed `ELEMENT_KINDS[type].defaults()` spread would need a cast.
export function creatingElement(c: CreatingState, style: StyleDefaults): VectorElement {
    const { x, y, width, height } = c.box;
    const placed = { id: CREATING_ID, x, y, width, height, angle: 0, seed: c.seed, index: 'a0' };
    if (c.tool === 'text') {
        // An empty text box paints nothing, so the drag needs an outline to size against. Preview-only: the
        // committed box keeps its transparent border.
        return {
            ...textBoxDefaults(style),
            ...placed,
            type: 'rectangle',
            strokeColor: style.strokeColor,
            strokeWidth: 1,
            strokeStyle: 'dashed',
        };
    }
    const base = { ...baseDefaultsFor(c.tool, style), ...placed };
    if (c.tool === 'ellipse') return { ...base, ...ELEMENT_KINDS.ellipse.defaults(style), type: 'ellipse' };
    if (c.tool === 'diamond') return { ...base, ...ELEMENT_KINDS.diamond.defaults(style), type: 'diamond' };
    if (c.tool === 'rectangle') return { ...base, ...ELEMENT_KINDS.rectangle.defaults(style), type: 'rectangle' };
    // Exhaustiveness guard: a new box-creation kind brings its own preview branch instead of silently
    // previewing as a rectangle (the kinds test pins the tools to the registry). It throws rather than
    // returning, so a type widened past the union can never reach the layer as a bare string.
    const exhaustive: never = c.tool;
    throw new Error(`no drag-create preview for ${String(exhaustive)}`);
}
