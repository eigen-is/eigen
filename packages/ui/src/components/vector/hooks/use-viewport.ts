// The canvas editor's pan and zoom. A gesture writes the live viewport to a ref and paints the nodes that show it once
// per animation frame, with no render; React state holds the viewport once input stops, which layout reads. Handlers
// that must be exact mid-gesture, such as clientToScene, read the ref. The infinite canvas pans and zooms freely, and
// frame mode holds one page at its fit. CanvasEditor calls it and attaches the nodes.

import type { Box, CanvasViewport, Extent } from '@workspace/lib/vector';
import {
    chromeTransform,
    clamp,
    clampFrameViewport,
    fitFrameViewport,
    groupTransform,
    sceneTransform,
} from '@workspace/lib/vector';
import type { CSSProperties, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const WHEEL_DELTA_CLAMP = 10;
// Long enough to span a trackpad's wheel stream and a pointerup, short enough that the zoom pill settles at once.
const COMMIT_DELAY_MS = 120;

const same = (a: CanvasViewport, b: CanvasViewport) =>
    a.zoom === b.zoom && a.scrollX === b.scrollX && a.scrollY === b.scrollY;

// Zoom to `nextZoom`, keeping the scene point under the container-relative (px, py) fixed.
const zoomAt = (v: CanvasViewport, nextZoom: number, px: number, py: number): CanvasViewport => ({
    zoom: nextZoom,
    scrollX: v.scrollX + px / nextZoom - px / v.zoom,
    scrollY: v.scrollY + py / nextZoom - py / v.zoom,
});

type UseViewportOptions = {
    // 'frame' always shows the whole page at its fit, with no user zoom and so no free pan.
    mode?: 'infinite' | 'frame';
    // The page's size; a new one re-fits like a frame switch, or the old fit would crop the page.
    frame?: Extent;
    // The active frame's id, whose change re-fits.
    resetKey?: string;
};

type Viewport = {
    containerRef: RefObject<HTMLDivElement | null>;
    // The three nodes whose position is the viewport.
    sceneRef: RefObject<HTMLDivElement | null>;
    overlayRef: RefObject<SVGGElement | null>;
    chromeRef: RefObject<HTMLDivElement | null>;
    // For handlers that must be exact mid-gesture; renders read `zoom` and `boxToStyle`.
    viewportRef: RefObject<CanvasViewport>;
    clientToScene: (clientX: number, clientY: number) => { x: number; y: number };
    screenDeltaToScene: (dxPx: number, dyPx: number) => { dx: number; dy: number };
    boxToStyle: (box: Box) => CSSProperties;
    panBy: (dxPx: number, dyPx: number) => void;
    pinch: (scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => void;
    resetZoom: () => void;
    centerOn: (x: number, y: number, rightInsetPx?: number) => void;
    frozenRef: RefObject<boolean>;
    zoom: number;
};

export function useViewport({ mode = 'infinite', frame, resetKey = '' }: UseViewportOptions = {}): Viewport {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<SVGGElement>(null);
    const chromeRef = useRef<HTMLDivElement>(null);

    const viewportRef = useRef<CanvasViewport>({ zoom: 1, scrollX: 0, scrollY: 0 });
    const [viewport, setViewport] = useState<CanvasViewport>(viewportRef.current);
    // The viewport the chrome layer was last laid out at — the base chromeTransform corrects from.
    const committedRef = useRef<CanvasViewport>(viewport);
    // Set while a drag runs, whose scale and pivot were captured at pointerdown, so the wheel and a pan start wait.
    const frozenRef = useRef(false);

    const { zoom, scrollX, scrollY } = viewport;

    // The live bounds, for the callbacks bound once below; null on the infinite canvas, which has no edges.
    const boundsRef = useRef<Extent | null>(null);
    boundsRef.current = mode === 'frame' && frame ? frame : null;
    // Frame mode is the lock, not the extent, so a deck whose frames have not loaded yet still holds still.
    const framedRef = useRef(false);
    framedRef.current = mode === 'frame';

    const containerExtent = useCallback((): Extent => {
        const rect = containerRef.current?.getBoundingClientRect();
        return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    }, []);

    // Every write but the fit's own passes here: a bounded page keeps its fit's zoom, and the clamp at that zoom pins
    // the scroll, so a pan settles back.
    const settle = useCallback(
        (next: CanvasViewport): CanvasViewport => {
            const bounds = boundsRef.current;
            if (!bounds) return framedRef.current ? viewportRef.current : next;
            return clampFrameViewport({ ...next, zoom: viewportRef.current.zoom }, containerExtent(), bounds);
        },
        [containerExtent],
    );

    // The chrome layer takes only the correction from the viewport its children were laid out at.
    const paint = useCallback(() => {
        const live = viewportRef.current;
        if (sceneRef.current) sceneRef.current.style.transform = sceneTransform(live);
        overlayRef.current?.setAttribute('transform', groupTransform(live));
        if (chromeRef.current) chromeRef.current.style.transform = chromeTransform(committedRef.current, live);
    }, []);

    const frameRef = useRef(0);
    const commitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // A gesture write. `next` reads the live viewport, never the state one, which lags a gesture.
    const write = useCallback(
        (next: (v: CanvasViewport) => CanvasViewport) => {
            const settled = settle(next(viewportRef.current));
            if (same(settled, viewportRef.current)) return;
            viewportRef.current = settled;
            if (!frameRef.current) {
                frameRef.current = requestAnimationFrame(() => {
                    frameRef.current = 0;
                    paint();
                });
            }
            if (commitRef.current) clearTimeout(commitRef.current);
            commitRef.current = setTimeout(() => {
                commitRef.current = null;
                setViewport(viewportRef.current);
            }, COMMIT_DELAY_MS);
        },
        [settle, paint],
    );

    // A write outside a gesture, such as the opening view or a fit, comes once per action, so it publishes at once.
    const set = useCallback((next: CanvasViewport) => {
        if (commitRef.current) {
            clearTimeout(commitRef.current);
            commitRef.current = null;
        }
        if (same(next, viewportRef.current)) return;
        viewportRef.current = next;
        setViewport(next);
    }, []);

    // After every render the chrome sits at `viewport` again. Before the browser paints, so the opening shows no flash.
    useLayoutEffect(() => {
        committedRef.current = viewport;
        paint();
    });

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (commitRef.current) clearTimeout(commitRef.current);
        },
        [],
    );

    // False until the container has a real size, so the opening effect keeps waiting.
    const fitFrame = useCallback((): boolean => {
        const bounds = boundsRef.current;
        if (!bounds) return false;
        const extent = containerExtent();
        if (extent.width === 0 || extent.height === 0) return false;
        set(fitFrameViewport(extent, bounds));
        return true;
    }, [containerExtent, set]);

    // The opening view waits for a real size, since a canvas under a phone's column measures 0. The infinite canvas
    // centers its origin once; frame mode keeps fitting the page on every resize.
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const framed = mode === 'frame';
        const open = () => {
            if (framed) return fitFrame();
            const { width, height } = el.getBoundingClientRect();
            if (width === 0 || height === 0) return false;
            const v = viewportRef.current;
            set({ ...v, scrollX: width / 2 / v.zoom, scrollY: height / 2 / v.zoom });
            return true;
        };
        if (open() && !framed) return;
        const observer = new ResizeObserver(() => {
            if (open() && !framed) observer.disconnect();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [mode, resetKey, frame?.width, frame?.height, fitFrame, set]);

    const clientToScene = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const ox = rect?.left ?? 0;
        const oy = rect?.top ?? 0;
        const v = viewportRef.current;
        return { x: (clientX - ox) / v.zoom - v.scrollX, y: (clientY - oy) / v.zoom - v.scrollY };
    }, []);

    // Uniform in x and y, which ObjectTransform's screen-space math relies on.
    const screenDeltaToScene = useCallback(
        (dxPx: number, dyPx: number) => ({ dx: dxPx / viewportRef.current.zoom, dy: dyPx / viewportRef.current.zoom }),
        [],
    );

    // A scene box's unrotated place in container px, at the committed viewport the chrome layer is laid out at. The
    // chrome adds its own rotate().
    const boxToStyle = useCallback(
        (box: Box): CSSProperties => ({
            left: (box.x + scrollX) * zoom,
            top: (box.y + scrollY) * zoom,
            width: box.width * zoom,
            height: box.height * zoom,
        }),
        [zoom, scrollX, scrollY],
    );

    // Scroll is in scene units.
    const panBy = useCallback(
        (dxPx: number, dyPx: number) => {
            write((v) => ({ ...v, scrollX: v.scrollX + dxPx / v.zoom, scrollY: v.scrollY + dyPx / v.zoom }));
        },
        [write],
    );

    // Zooms about the pinch's midpoint and pans by its travel. A pinch is the active gesture, so frozenRef doesn't
    // stop it.
    const pinch = useCallback(
        (scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => {
            write((v) => {
                const nextZoom = clamp(v.zoom * scale, MIN_ZOOM, MAX_ZOOM);
                const z = zoomAt(v, nextZoom, px, py);
                return {
                    zoom: nextZoom,
                    scrollX: z.scrollX + panDxPx / nextZoom,
                    scrollY: z.scrollY + panDyPx / nextZoom,
                };
            });
        },
        [write],
    );

    // Back to 100% about the container's center. A bounded page has no zoom of its own, so it re-fits.
    const resetZoom = useCallback(() => {
        if (fitFrame()) return;
        const { width, height } = containerExtent();
        set(settle(zoomAt(viewportRef.current, 1, width / 2, height / 2)));
    }, [fitFrame, containerExtent, settle, set]);

    // Centers a scene point in the container short of `rightInsetPx` at the right, such as the room a column is about
    // to grow into. A bounded page settles back to its fit, and an unmeasured container is left to the opening view.
    const centerOn = useCallback(
        (x: number, y: number, rightInsetPx = 0) => {
            const { width, height } = containerExtent();
            if (width === 0 || height === 0) return;
            const { zoom } = viewportRef.current;
            set(settle({ zoom, scrollX: (width - rightInsetPx) / 2 / zoom - x, scrollY: height / 2 / zoom - y }));
        },
        [containerExtent, settle, set],
    );

    // Non-passive, so it can stop the page scroll: a wheel pans, and with ctrl or meta, which a trackpad pinch sends,
    // it zooms at the cursor.
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
                write((v) => {
                    const nextZoom = clamp(v.zoom - delta / 100, MIN_ZOOM, MAX_ZOOM);
                    return nextZoom === v.zoom ? v : zoomAt(v, nextZoom, px, py);
                });
            } else {
                const dx = e.shiftKey ? e.deltaY : e.deltaX;
                const dy = e.shiftKey ? 0 : e.deltaY;
                write((v) => ({ ...v, scrollX: v.scrollX - dx / v.zoom, scrollY: v.scrollY - dy / v.zoom }));
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [write]);

    return {
        containerRef,
        sceneRef,
        overlayRef,
        chromeRef,
        viewportRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        panBy,
        pinch,
        resetZoom,
        centerOn,
        frozenRef,
        zoom,
    };
}
