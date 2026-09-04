// Pan/zoom viewport for the canvas editor. scene = (client - offset)/zoom - scroll (Excalidraw's
// convention; scroll is stored in SCENE units). The SVG zoom group and the screen-space chrome
// overlay share the container origin, so viewport-relative px = (scene + scroll) * zoom.
//
// The LIVE viewport lives in a ref, not in React state: a pan/zoom event writes the ref and one rAF
// paints the three nodes that are the viewport (the scene layer, the overlay group, the chrome layer),
// so a gesture costs no render at all. React state is the last COMMITTED viewport, published on a
// trailing timer — one render per gesture — and it is what layout reads: `boxToStyle`, the zoom pill,
// the snap thresholds. Anything that must be exact MID-gesture (clientToScene, screenDeltaToScene, a
// hit threshold) reads `viewportRef` instead, which is why those functions are identity-stable.

import type { Box, CanvasViewport, Extent } from '@workspace/lib/vector';
import {
    chromeTransform,
    clamp,
    clampFrameViewport,
    fitFrameViewport,
    groupTransform,
    sceneTransform,
} from '@workspace/lib/vector';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const WHEEL_DELTA_CLAMP = 10;
// Trailing delay before a gesture's viewport reaches React: long enough to span a trackpad's wheel
// stream and a pointerup, short enough that the zoom pill settles as soon as the input stops.
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
    // 'frame' bounds the canvas to one page: it always shows the whole page — fitted on open, re-fitted
    // on every container resize and frame switch — with the zoom LOCKED to that fit, so there is no
    // user zoom and, following from the clamp, no free pan either.
    mode?: 'infinite' | 'frame';
    frame?: Extent;
    // Re-fit when this changes (the active frame's id).
    resetKey?: string;
};

export function useViewport({ mode = 'infinite', frame, resetKey = '' }: UseViewportOptions = {}) {
    const containerRef = useRef<HTMLDivElement>(null);
    // The three nodes whose position IS the viewport. The canvas attaches them; the rAF writes them.
    const sceneRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<SVGGElement>(null);
    const chromeRef = useRef<HTMLDivElement>(null);

    const viewportRef = useRef<CanvasViewport>({ zoom: 1, scrollX: 0, scrollY: 0 });
    const [viewport, setViewport] = useState<CanvasViewport>(viewportRef.current);
    // The viewport the chrome layer was last laid out at — the base chromeTransform corrects from.
    const committedRef = useRef<CanvasViewport>(viewport);
    // Frozen while any drag is active: a mid-drag pan/zoom silently invalidates the
    // screenDeltaToScene scale and the rotate pivot captured at pointerdown (UX-RULING 10). The
    // canvas flips this ref around every gesture; the wheel handler and pan start both honor it.
    const frozenRef = useRef(false);

    const { zoom, scrollX, scrollY } = viewport;

    // The live bounds, for the callbacks bound once below (the wheel listener, pinch, panBy). Null on
    // the infinite canvas, which has no edges to hold a pan inside.
    const boundsRef = useRef<Extent | null>(null);
    boundsRef.current = mode === 'frame' && frame ? frame : null;
    // Frame mode is the lock, not the extent: a deck whose frames have not loaded yet is still a bounded
    // page, and the zoom pill is already hidden on the same fact. Read by `settle`, which freezes rather
    // than letting a wheel zoom the page free while there is nothing to clamp against.
    const framedRef = useRef(false);
    framedRef.current = mode === 'frame';

    const containerExtent = useCallback((): Extent => {
        const rect = containerRef.current?.getBoundingClientRect();
        return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    }, []);

    // Every viewport write goes through here, so the two rules of a bounded page live in one place
    // instead of at each callsite: its ZOOM is the fit's answer, never the user's — a ctrl-wheel, a
    // pinch or a zoom shortcut keeps the zoom it came in with — and a pan may never push the page off
    // screen. Holding the zoom is what makes the pan moot too: at the fit, the clamp pins the scroll to
    // the centred value on both axes, so a pan settles back to where it started. Only `set` (the fit
    // itself) bypasses this.
    const settle = useCallback(
        (next: CanvasViewport): CanvasViewport => {
            const bounds = boundsRef.current;
            if (!bounds) return framedRef.current ? viewportRef.current : next;
            return clampFrameViewport({ ...next, zoom: viewportRef.current.zoom }, containerExtent(), bounds);
        },
        [containerExtent],
    );

    // The live viewport, straight to the DOM: the scene layer and the overlay group take it whole, the
    // chrome layer takes the correction from the viewport its children were laid out at.
    const paint = useCallback(() => {
        const live = viewportRef.current;
        if (sceneRef.current) sceneRef.current.style.transform = sceneTransform(live);
        overlayRef.current?.setAttribute('transform', groupTransform(live));
        if (chromeRef.current) chromeRef.current.style.transform = chromeTransform(committedRef.current, live);
    }, []);

    const frameRef = useRef(0);
    const commitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // A gesture write: settle, store, paint once per animation frame, and publish to React once the
    // input stops. `next` reads the LIVE viewport — never the state one, which lags a gesture.
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

    // The non-gesture writes (the opening view, a frame fit, the zoom-pill reset): one per user action
    // or layout pass, so they publish to React at once and the layout effect below paints them.
    const set = useCallback((next: CanvasViewport) => {
        if (commitRef.current) {
            clearTimeout(commitRef.current);
            commitRef.current = null;
        }
        if (same(next, viewportRef.current)) return;
        viewportRef.current = next;
        setViewport(next);
    }, []);

    // After every render the chrome sits at `viewport` again: rebase, then repaint from the live value.
    // Runs before the browser paints, so it also plants the opening transform without a flash.
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

    // Letterbox the frame in the measured container. False until the container has a real size, so the
    // opening effect below knows to keep waiting.
    const fitFrame = useCallback((): boolean => {
        const bounds = boundsRef.current;
        if (!bounds) return false;
        const extent = containerExtent();
        if (extent.width === 0 || extent.height === 0) return false;
        set(fitFrameViewport(extent, bounds));
        return true;
    }, [containerExtent, set]);

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
    }, [mode, resetKey, fitFrame, set]);

    const clientToScene = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const ox = rect?.left ?? 0;
        const oy = rect?.top ?? 0;
        const v = viewportRef.current;
        return { x: (clientX - ox) / v.zoom - v.scrollX, y: (clientY - oy) / v.zoom - v.scrollY };
    }, []);

    // Uniform scale in x and y — the seam precondition ObjectTransform's screen-space math relies on.
    const screenDeltaToScene = useCallback(
        (dxPx: number, dyPx: number) => ({ dx: dxPx / viewportRef.current.zoom, dy: dyPx / viewportRef.current.zoom }),
        [],
    );

    // Container-relative px position/size of a scene box's unrotated top-left + extent; the chrome
    // overlay adds transform: rotate() itself, so this is position/size only. Reads the COMMITTED
    // viewport: it lays out the chrome layer, whose live correction is chromeTransform.
    const boxToStyle = useCallback(
        (box: Box): React.CSSProperties => ({
            left: (box.x + scrollX) * zoom,
            top: (box.y + scrollY) * zoom,
            width: box.width * zoom,
            height: box.height * zoom,
        }),
        [zoom, scrollX, scrollY],
    );

    // Incremental pan by a screen-px delta (space-drag / middle-mouse); scroll is scene units.
    const panBy = useCallback(
        (dxPx: number, dyPx: number) => {
            write((v) => ({ ...v, scrollX: v.scrollX + dxPx / v.zoom, scrollY: v.scrollY + dyPx / v.zoom }));
        },
        [write],
    );

    // Two-finger pinch: zoom by `scale` about the container-relative (px, py) midpoint AND pan by the
    // midpoint's screen travel — the imperative entry the touch module drives so the viewport stays the
    // single owner of the clamp/anchor math (never duplicated in the gesture module). Not gated on
    // frozenRef: a pinch IS the active gesture.
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

    // Zoom-pill reset: back to 100%, keeping the scene point at the container centre fixed. A bounded
    // page has no zoom of its own, so it re-fits instead (the pill is hidden there anyway).
    const resetZoom = useCallback(() => {
        if (fitFrame()) return;
        const { width, height } = containerExtent();
        set(settle(zoomAt(viewportRef.current, 1, width / 2, height / 2)));
    }, [fitFrame, containerExtent, settle, set]);

    // Non-passive wheel: pan by default, zoom-at-cursor on ctrl/meta (trackpad pinch sends ctrl).
    // Bound once; reads the live viewport through `write` and the container rect at call time.
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
        // The LIVE viewport, for event handlers (a hit threshold, an image placement) that must be
        // exact while a gesture runs ahead of React. Renders read `zoom` / `boxToStyle` instead.
        viewportRef,
        clientToScene,
        screenDeltaToScene,
        boxToStyle,
        panBy,
        pinch,
        resetZoom,
        frozenRef,
        zoom,
    };
}
