// Viewport math for a BOUNDED canvas. The infinite canvas needs none of this — it scrolls forever and
// opens at the origin — but a frame is a page: it opens fitted, and a pan may never push it off screen.
// Pure, so every host resolves the same numbers. Scroll is in SCENE units and scene maps to px as
// (scene + scroll) * zoom, the canvas-wide convention.

export type CanvasViewport = { zoom: number; scrollX: number; scrollY: number };
export type Extent = { width: number; height: number };

// Screen px of breathing room around a fitted frame.
const FRAME_FIT_PADDING = 24;

// The page card: the frame is drawn as a bordered, slightly rounded card, so the user sees where the
// page ends. Both are SCREEN px. The ring is drawn in the screen-space chrome layer at exactly these
// numbers — a border counter-scaled inside the SCALED scene layer would not hold its weight, because
// the browser floors border-width to whole CSS px (at a 0.57 fit, 1/0.57 = 1.76px floors to 1px, a
// blurry 0.57px hairline that drifts with the fit) — while the clip the card applies to overhanging
// elements does live in the scene layer, and takes its radius in scene units from `frameClipRadius`.
export const FRAME_CARD_BORDER = 1;
export const FRAME_CARD_RADIUS = 8;

export function frameClipRadius(zoom: number): number {
    return FRAME_CARD_RADIUS / zoom;
}

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

// The scene layer's CSS transform and the overlay group's SVG transform: ONE mapping in two syntaxes,
// applied with transform-origin 0 0 at both callsites, so the two surfaces stay registered at any zoom.
export function sceneTransform(v: CanvasViewport): string {
    return `translate(${v.scrollX * v.zoom}px, ${v.scrollY * v.zoom}px) scale(${v.zoom})`;
}

export function groupTransform(v: CanvasViewport): string {
    return `translate(${v.scrollX * v.zoom} ${v.scrollY * v.zoom}) scale(${v.zoom})`;
}

// Screen-space chrome (selection ring, comment flags, peer cursors) is laid out at the viewport React
// last rendered; a live gesture runs ahead of that. This is the correction that carries that layout
// onto `live` — scene positions and scene-sized boxes land exactly right, screen-sized details (a
// border, a grip) ride the scale until the gesture commits. '' when the two agree: the resting case.
export function chromeTransform(rendered: CanvasViewport, live: CanvasViewport): string {
    if (live.zoom === rendered.zoom && live.scrollX === rendered.scrollX && live.scrollY === rendered.scrollY)
        return '';
    const scale = live.zoom / rendered.zoom;
    const dx = (live.scrollX - rendered.scrollX) * live.zoom;
    const dy = (live.scrollY - rendered.scrollY) * live.zoom;
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
}
