// The canvas surface cursor, resolved from the pan, tool and hover state so the canvas only dispatches. Pan wins
// (grabbing while panning, grab in pan mode), then a drawing tool shows a crosshair and the Text tool a caret, then
// the select tool shows `move` over a draggable element, as the other apps do, and `default` over empty canvas.

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
    if (tool === 'text') return 'text';
    if (tool !== 'select') return 'crosshair';
    return hoveringSelectable ? 'move' : 'default';
}
