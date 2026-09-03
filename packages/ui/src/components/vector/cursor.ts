// The canvas surface cursor, resolved from the current pan/tool/hover state. Split out of
// vector-canvas.tsx (the canvas only dispatches) so this file doesn't grow: pan wins (grabbing while
// panning, grab in pan mode), then a drawing tool shows crosshair (text its own caret), then
// select shows `move` over a draggable element (the suite convention) and `default` over empty canvas.

import type { VectorTool } from './hooks/use-tool';

export function pointerCursor(state: {
    panning: boolean;
    panMode: boolean;
    tool: VectorTool;
    hoveringSelectable: boolean;
}): string {
    const { panning, panMode, tool, hoveringSelectable } = state;
    if (panning) return 'grabbing';
    if (panMode) return 'grab';
    if (tool === 'richtext') return 'text';
    if (tool !== 'select') return 'crosshair';
    return hoveringSelectable ? 'move' : 'default';
}
