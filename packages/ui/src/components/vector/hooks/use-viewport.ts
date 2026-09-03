// Pan/zoom viewport for the vector canvas. scene = (client - offset)/zoom - scroll (Excalidraw's
// convention; scroll is stored in SCENE units). The SVG zoom group and the screen-space chrome
// overlay share the container origin, so viewport-relative px = (scene + scroll) * zoom.

import type { Box } from '@workspace/lib/vector';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const WHEEL_DELTA_CLAMP = 10;

type ViewportState = { zoom: number; scrollX: number; scrollY: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Zoom to `nextZoom`, keeping the scene point under the container-relative (px, py) fixed.
const zoomAt = (v: ViewportState, nextZoom: number, px: number, py: number): ViewportState => ({
    zoom: nextZoom,
    scrollX: v.scrollX + px / nextZoom - px / v.zoom,
    scrollY: v.scrollY + py / nextZoom - py / v.zoom,
});

export function useViewport() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportState>({ zoom: 1, scrollX: 0, scrollY: 0 });
    // Frozen while any drag is active: a mid-drag pan/zoom silently invalidates the
    // screenDeltaToScene scale and the rotate pivot captured at pointerdown (UX-RULING 10). The
    // canvas flips this ref around every gesture; the wheel handler and pan start both honor it.
    const frozenRef = useRef(false);

    const { zoom, scrollX, scrollY } = viewport;

    // Scene origin at the container centre on open. Waits for a real size: a mobile comment deep
    // link mounts the canvas inside a hidden wrapper, which measures 0 until the pane closes.
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const centre = () => {
            const { width, height } = el.getBoundingClientRect();
            if (width === 0 || height === 0) return false;
            setViewport((v) => ({ ...v, scrollX: width / 2 / v.zoom, scrollY: height / 2 / v.zoom }));
            return true;
        };
        if (centre()) return;
        const observer = new ResizeObserver(() => {
            if (centre()) observer.disconnect();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

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

    // Incremental pan by a screen-px delta (space-drag / middle-mouse); scroll is scene units.
    const panBy = useCallback((dxPx: number, dyPx: number) => {
        setViewport((v) => ({ ...v, scrollX: v.scrollX + dxPx / v.zoom, scrollY: v.scrollY + dyPx / v.zoom }));
    }, []);

    // Two-finger pinch: zoom by `scale` about the container-relative (px, py) midpoint AND pan by the
    // midpoint's screen travel — the imperative entry the touch module drives so the viewport stays the
    // single owner of the clamp/anchor math (never duplicated in the gesture module). Not gated on
    // frozenRef: a pinch IS the active gesture.
    const pinch = useCallback((scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => {
        setViewport((v) => {
            const nextZoom = clamp(v.zoom * scale, MIN_ZOOM, MAX_ZOOM);
            const z = zoomAt(v, nextZoom, px, py);
            return { zoom: nextZoom, scrollX: z.scrollX + panDxPx / nextZoom, scrollY: z.scrollY + panDyPx / nextZoom };
        });
    }, []);

    // Zoom-pill reset: back to 100%, keeping the scene point at the container centre fixed.
    const resetZoom = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const px = (rect?.width ?? 0) / 2;
        const py = (rect?.height ?? 0) / 2;
        setViewport((v) => zoomAt(v, 1, px, py));
    }, []);

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
                    return nextZoom === v.zoom ? v : zoomAt(v, nextZoom, px, py);
                });
            } else {
                const dx = e.shiftKey ? e.deltaY : e.deltaX;
                const dy = e.shiftKey ? 0 : e.deltaY;
                setViewport((v) => ({ ...v, scrollX: v.scrollX - dx / v.zoom, scrollY: v.scrollY - dy / v.zoom }));
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    return {
        containerRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        groupTransform,
        panBy,
        pinch,
        resetZoom,
        frozenRef,
        zoom,
    };
}
