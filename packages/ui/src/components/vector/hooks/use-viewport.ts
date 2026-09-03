// Pan/zoom viewport for the canvas editor. scene = (client - offset)/zoom - scroll (Excalidraw's
// convention; scroll is stored in SCENE units). The SVG zoom group and the screen-space chrome
// overlay share the container origin, so viewport-relative px = (scene + scroll) * zoom.

import type { Box, CanvasViewport, Extent } from '@workspace/lib/vector';
import { clampFrameViewport, fitFrameViewport } from '@workspace/lib/vector';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const WHEEL_DELTA_CLAMP = 10;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Zoom to `nextZoom`, keeping the scene point under the container-relative (px, py) fixed.
const zoomAt = (v: CanvasViewport, nextZoom: number, px: number, py: number): CanvasViewport => ({
    zoom: nextZoom,
    scrollX: v.scrollX + px / nextZoom - px / v.zoom,
    scrollY: v.scrollY + py / nextZoom - py / v.zoom,
});

export type UseViewportOptions = {
    // 'frame' bounds the canvas to one page: it opens fitted and pans are clamped to its edges.
    mode?: 'infinite' | 'frame';
    frame?: Extent;
    // Re-fit when this changes (the active frame's id) — a frame switch resets the pan.
    resetKey?: string;
};

export function useViewport({ mode = 'infinite', frame, resetKey = '' }: UseViewportOptions = {}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<CanvasViewport>({ zoom: 1, scrollX: 0, scrollY: 0 });
    // Frozen while any drag is active: a mid-drag pan/zoom silently invalidates the
    // screenDeltaToScene scale and the rotate pivot captured at pointerdown (UX-RULING 10). The
    // canvas flips this ref around every gesture; the wheel handler and pan start both honor it.
    const frozenRef = useRef(false);

    const { zoom, scrollX, scrollY } = viewport;

    // The live bounds, for the callbacks bound once below (the wheel listener, pinch, panBy). Null on
    // the infinite canvas, which has no edges to hold a pan inside.
    const boundsRef = useRef<Extent | null>(null);
    boundsRef.current = mode === 'frame' && frame ? frame : null;

    const containerExtent = useCallback((): Extent => {
        const rect = containerRef.current?.getBoundingClientRect();
        return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    }, []);

    // Every viewport write goes through here, so "a pan may never push the frame off screen" is one
    // rule in one place instead of a clamp at each callsite.
    const settle = useCallback(
        (next: CanvasViewport): CanvasViewport => {
            const bounds = boundsRef.current;
            return bounds ? clampFrameViewport(next, containerExtent(), bounds) : next;
        },
        [containerExtent],
    );

    // Letterbox the frame in the measured container. False until the container has a real size, so the
    // opening effect below knows to keep waiting.
    const fitFrame = useCallback((): boolean => {
        const bounds = boundsRef.current;
        if (!bounds) return false;
        const extent = containerExtent();
        if (extent.width === 0 || extent.height === 0) return false;
        setViewport(fitFrameViewport(extent, bounds));
        return true;
    }, [containerExtent]);

    // Opening view: the scene origin at the container centre (infinite), or the frame letterboxed
    // (frame mode, re-run on every `resetKey` change so a frame switch resets the pan). Waits for a
    // real size: a mobile comment deep link mounts the canvas inside a hidden wrapper, which measures
    // 0 until the pane closes. Frame mode keeps observing — a letterboxed page must stay letterboxed
    // across a resize; infinite mode centres once and disconnects.
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const framed = mode === 'frame';
        const open = () => {
            if (framed) return fitFrame();
            const { width, height } = el.getBoundingClientRect();
            if (width === 0 || height === 0) return false;
            setViewport((v) => ({ ...v, scrollX: width / 2 / v.zoom, scrollY: height / 2 / v.zoom }));
            return true;
        };
        if (open() && !framed) return;
        const observer = new ResizeObserver(() => {
            if (open() && !framed) observer.disconnect();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [mode, resetKey, fitFrame]);

    const clientToScene = useCallback(
        (clientX: number, clientY: number) => {
            const rect = containerRef.current?.getBoundingClientRect();
            const ox = rect?.left ?? 0;
            const oy = rect?.top ?? 0;
            return { x: (clientX - ox) / zoom - scrollX, y: (clientY - oy) / zoom - scrollY };
        },
        [zoom, scrollX, scrollY],
    );

    // Uniform scale in x and y — the seam precondition ObjectTransform's screen-space math relies on.
    const screenDeltaToScene = useCallback(
        (dxPx: number, dyPx: number) => ({ dx: dxPx / zoom, dy: dyPx / zoom }),
        [zoom],
    );

    // Container-relative px position/size of a scene box's unrotated top-left + extent; the chrome
    // overlay adds transform: rotate() itself, so this is position/size only.
    const boxToStyle = useCallback(
        (box: Box): React.CSSProperties => ({
            left: (box.x + scrollX) * zoom,
            top: (box.y + scrollY) * zoom,
            width: box.width * zoom,
            height: box.height * zoom,
        }),
        [zoom, scrollX, scrollY],
    );

    const groupTransform = `translate(${scrollX * zoom} ${scrollY * zoom}) scale(${zoom})`;

    // The scene div's CSS transform: the same mapping groupTransform applies inside the overlay SVG,
    // so layer boxes are plain SCENE units and the two surfaces stay registered at any zoom.
    // transform-origin must be 0 0 at the callsite (the SVG group's origin is the container corner).
    const sceneTransform = `translate(${scrollX * zoom}px, ${scrollY * zoom}px) scale(${zoom})`;

    // Incremental pan by a screen-px delta (space-drag / middle-mouse); scroll is scene units.
    const panBy = useCallback(
        (dxPx: number, dyPx: number) => {
            setViewport((v) =>
                settle({ ...v, scrollX: v.scrollX + dxPx / v.zoom, scrollY: v.scrollY + dyPx / v.zoom }),
            );
        },
        [settle],
    );

    // Two-finger pinch: zoom by `scale` about the container-relative (px, py) midpoint AND pan by the
    // midpoint's screen travel — the imperative entry the touch module drives so the viewport stays the
    // single owner of the clamp/anchor math (never duplicated in the gesture module). Not gated on
    // frozenRef: a pinch IS the active gesture.
    const pinch = useCallback(
        (scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => {
            setViewport((v) => {
                const nextZoom = clamp(v.zoom * scale, MIN_ZOOM, MAX_ZOOM);
                const z = zoomAt(v, nextZoom, px, py);
                return settle({
                    zoom: nextZoom,
                    scrollX: z.scrollX + panDxPx / nextZoom,
                    scrollY: z.scrollY + panDyPx / nextZoom,
                });
            });
        },
        [settle],
    );

    // Zoom-pill reset: back to 100%, keeping the scene point at the container centre fixed.
    const resetZoom = useCallback(() => {
        const { width, height } = containerExtent();
        setViewport((v) => settle(zoomAt(v, 1, width / 2, height / 2)));
    }, [containerExtent, settle]);

    // Non-passive wheel: pan by default, zoom-at-cursor on ctrl/meta (trackpad pinch sends ctrl).
    // Bound once; reads live viewport via functional setState and the container rect at call time.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (frozenRef.current) return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const rect = el.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const delta = clamp(e.deltaY, -WHEEL_DELTA_CLAMP, WHEEL_DELTA_CLAMP);
                setViewport((v) => {
                    const nextZoom = clamp(v.zoom - delta / 100, MIN_ZOOM, MAX_ZOOM);
                    return nextZoom === v.zoom ? v : settle(zoomAt(v, nextZoom, px, py));
                });
            } else {
                const dx = e.shiftKey ? e.deltaY : e.deltaX;
                const dy = e.shiftKey ? 0 : e.deltaY;
                setViewport((v) =>
                    settle({ ...v, scrollX: v.scrollX - dx / v.zoom, scrollY: v.scrollY - dy / v.zoom }),
                );
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [settle]);

    return {
        containerRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        groupTransform,
        sceneTransform,
        panBy,
        pinch,
        resetZoom,
        frozenRef,
        zoom,
    };
}
