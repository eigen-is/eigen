// Pan/zoom viewport for the vector canvas. scene = (client - offset)/zoom - scroll (Excalidraw's
// convention; scroll is stored in SCENE units). The SVG zoom group and the screen-space chrome
// overlay share the container origin, so viewport-relative px = (scene + scroll) * zoom.

import type { Box } from '@workspace/lib/vector';
import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const WHEEL_DELTA_CLAMP = 10;

type ViewportState = { zoom: number; scrollX: number; scrollY: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function useViewport() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportState>({ zoom: 1, scrollX: 0, scrollY: 0 });
    // Frozen while any drag is active: a mid-drag pan/zoom silently invalidates the
    // screenDeltaToScene scale and the rotate pivot captured at pointerdown (UX-RULING 10). The
    // canvas flips this ref around every gesture; the wheel handler and pan start both honor it.
    const frozenRef = useRef(false);

    const { zoom, scrollX, scrollY } = viewport;

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
    // overlay adds transform: rotate() itself, so this is position/size only (CONTRACT §D).
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
                    if (nextZoom === v.zoom) return v;
                    // Keep the scene point under the cursor fixed.
                    return {
                        zoom: nextZoom,
                        scrollX: v.scrollX + px / nextZoom - px / v.zoom,
                        scrollY: v.scrollY + py / nextZoom - py / v.zoom,
                    };
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

    return { containerRef, clientToScene, screenDeltaToScene, boxToStyle, groupTransform, panBy, frozenRef, zoom };
}
