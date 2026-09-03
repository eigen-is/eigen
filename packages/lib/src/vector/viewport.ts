// Viewport math for a BOUNDED canvas. The infinite canvas needs none of this — it scrolls forever and
// opens at the origin — but a frame is a page: it opens fitted, and a pan may never push it off screen.
// Pure, so both the live hook and the deck shell's thumbnails resolve the same numbers. Scroll is in
// SCENE units and scene maps to px as (scene + scroll) * zoom, the canvas-wide convention.

export type CanvasViewport = { zoom: number; scrollX: number; scrollY: number };
export type Extent = { width: number; height: number };

// Screen px of breathing room around a fitted frame.
export const FRAME_FIT_PADDING = 24;

// Centres `extent` in `visible` scene units, or clamps the pan to its edges when it is the larger of
// the two — the visible window then stays inside the extent instead of running past it.
function clampAxis(scroll: number, visible: number, extent: number): number {
    if (visible >= extent) return (visible - extent) / 2;
    return Math.min(0, Math.max(visible - extent, scroll));
}

export function clampFrameViewport(v: CanvasViewport, container: Extent, frame: Extent): CanvasViewport {
    return {
        zoom: v.zoom,
        scrollX: clampAxis(v.scrollX, container.width / v.zoom, frame.width),
        scrollY: clampAxis(v.scrollY, container.height / v.zoom, frame.height),
    };
}

// Letterbox: the largest zoom that shows the whole frame with padding, centred. A container that has
// not been measured yet (0x0) still yields a positive zoom, so nothing divides by zero downstream.
export function fitFrameViewport(container: Extent, frame: Extent, padding = FRAME_FIT_PADDING): CanvasViewport {
    const width = Math.max(1, container.width - padding * 2);
    const height = Math.max(1, container.height - padding * 2);
    const zoom = Math.min(width / frame.width, height / frame.height);
    return clampFrameViewport({ zoom, scrollX: 0, scrollY: 0 }, container, frame);
}

// The frame's own edges and centre lines as snap targets, so an object aligns to the page the way it
// aligns to its neighbours (computeSnapTargets' extraV/extraH seam).
export function frameSnapExtras(frame: Extent): { extraV: number[]; extraH: number[] } {
    return {
        extraV: [0, frame.width / 2, frame.width],
        extraH: [0, frame.height / 2, frame.height],
    };
}
