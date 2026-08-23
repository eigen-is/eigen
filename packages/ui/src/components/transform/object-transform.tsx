// Shared selection/resize/rotate chrome — the one primitive slides, docs, sheets, and vector
// converge on (CONTRACT §D). It owns the selection ring, the eight square resize grips, the
// round rotate grip, the whole pointer lifecycle, and live Shift/Alt tracking. The host owns
// only its coordinate space (`boxToStyle` + `screenDeltaToScene`) and the single commit.
//
// The math runs in scene units (degrees); the grip px offsets live inside the ring and are
// scale-independent in every host, so the seam stays tiny. Single-box only: multi-select is a
// plain ring the host draws itself, so this component is simply not mounted for it (no
// `showResize` prop — an ObjectTransform that can't transform isn't rendered).

import { type Box, normalizeAngle, resizeRotatedRect, snapAngle } from '@workspace/lib/vector';
import { cn } from '@workspace/ui/lib/utils';
import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// Base cursor by handle orientation; a rotated box advances the index one step per 45°.
const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'] as const;

// 4 corners (always shown) + 4 side midpoints (`side`, gated by the 40px screen threshold).
// `cursorIndex` is the unrotated base index into RESIZE_CURSORS.
const RESIZE_HANDLES = [
    { mode: 'resize-nw', position: '-top-1.5 -left-1.5', cursorIndex: 3, side: false },
    { mode: 'resize-ne', position: '-top-1.5 -right-1.5', cursorIndex: 1, side: false },
    { mode: 'resize-sw', position: '-bottom-1.5 -left-1.5', cursorIndex: 1, side: false },
    { mode: 'resize-se', position: '-bottom-1.5 -right-1.5', cursorIndex: 3, side: false },
    { mode: 'resize-n', position: '-top-1.5 left-1/2 -translate-x-1/2', cursorIndex: 0, side: true },
    { mode: 'resize-s', position: '-bottom-1.5 left-1/2 -translate-x-1/2', cursorIndex: 0, side: true },
    { mode: 'resize-w', position: 'top-1/2 -left-1.5 -translate-y-1/2', cursorIndex: 2, side: true },
    { mode: 'resize-e', position: 'top-1/2 -right-1.5 -translate-y-1/2', cursorIndex: 2, side: true },
] as const;

// Below this on-screen size the 12px grips swallow the element, so the 4 side grips hide and
// only the corners remain (SCOUT §2).
const SIDE_GRIP_MIN_SCREEN_PX = 40;
const DEFAULT_MIN_SIZE = 1;

function cursorFor(cursorIndex: number, angle: number): string {
    const step = (((Math.round(angle / 45) % 4) + 4) % 4) + cursorIndex;
    return RESIZE_CURSORS[step % 4];
}

function sameBox(a: Box, b: Box): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.angle === b.angle;
}

export type ObjectTransformProps = {
    // Element bounds in scene units, degrees. Single box only — multi-select never mounts this.
    box: Box;
    // Host positioning of the ring: percent CSS (slides) or px-from-zoom (vector). Position/size
    // ONLY — the component owns `transform: rotate(angle)` + center origin itself.
    boxToStyle: (box: Box) => React.CSSProperties;
    // Convert a screen-px pointer delta to scene units. MUST be a uniform x/y scale — that is
    // what makes the screen-space rotate math and the self-measured pivot exact in both hosts.
    screenDeltaToScene: (dxPx: number, dyPx: number) => { dx: number; dy: number };
    // Rotate grip visibility (hosts hide it for multi-select, which never mounts this anyway).
    showRotate: boolean;
    // Scene-unit resize floor (slides 30, vector ~1). Defaults to 1.
    minSize?: number;
    // Per-move LOCAL preview — never a Yjs write. The host feeds the result back in as `box`.
    onTransform: (next: Box) => void;
    // Fires exactly once per gesture at pointerup / window-blur / pointercancel, with angle
    // normalized to [0, 360). A no-op gesture (no movement) does not fire it. This is the host's
    // single write. The host MUST freeze its viewport (pan/zoom) while a drag is active: the
    // rotate pivot and the `screenDeltaToScene` closure are captured at pointerdown, and a
    // viewport change mid-drag would silently invalidate both.
    onCommit: (next: Box) => void;
};

export function ObjectTransform({
    box,
    boxToStyle,
    screenDeltaToScene,
    showRotate,
    minSize = DEFAULT_MIN_SIZE,
    onTransform,
    onCommit,
}: ObjectTransformProps) {
    const [rotating, setRotating] = useState(false);
    // Frozen while any grip drag is active so a resize that shrinks the on-screen box below the side
    // threshold can't unmount the very grip holding pointer capture (the side grips would vanish).
    const [dragging, setDragging] = useState(false);
    const ringRef = useRef<HTMLDivElement>(null);
    // Live drag listeners live on document/window, not React — a remote peer deleting the element
    // mid-drag would unmount us before teardown runs and leak them. One AbortController per gesture,
    // also aborted on unmount, guarantees removal.
    const dragAbort = useRef<AbortController | null>(null);
    useEffect(() => () => dragAbort.current?.abort(), []);

    const startResize = (e: React.PointerEvent, mode: string) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const controller = new AbortController();
        dragAbort.current = controller;
        const { signal } = controller;
        setDragging(true);
        const snapshot = box;
        const startX = e.clientX;
        const startY = e.clientY;
        const cursor = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey, shiftKey: e.shiftKey };
        let latest: Box | null = null;

        const update = () => {
            const { dx, dy } = screenDeltaToScene(cursor.clientX - startX, cursor.clientY - startY);
            const next = resizeRotatedRect(
                mode,
                dx,
                dy,
                snapshot,
                { fromCenter: cursor.altKey, keepAspect: cursor.shiftKey },
                minSize,
            );
            latest = next;
            onTransform(next);
        };

        const onMove = (me: PointerEvent) => {
            cursor.clientX = me.clientX;
            cursor.clientY = me.clientY;
            cursor.altKey = me.altKey;
            cursor.shiftKey = me.shiftKey;
            update();
        };
        // Live re-derivation from the snapshot when Alt/Shift toggle mid-drag; Escape cancels.
        // Capture phase + stopPropagation so the host's layered Escape can't also fire (deselect)
        // and unmount us mid-drag (the slides layered-Escape discipline).
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key === 'Escape') {
                ke.preventDefault();
                ke.stopPropagation();
                return cancel();
            }
            if (ke.key !== 'Alt' && ke.key !== 'Shift') return;
            cursor.altKey = ke.altKey;
            cursor.shiftKey = ke.shiftKey;
            update();
        };
        const teardown = () => {
            setDragging(false);
            controller.abort();
        };
        const commit = () => {
            teardown();
            if (latest && !sameBox(latest, snapshot)) onCommit({ ...latest, angle: normalizeAngle(latest.angle) });
        };
        const cancel = () => {
            teardown();
            onTransform(snapshot);
        };

        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', commit, { signal });
        document.addEventListener('pointercancel', commit, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
        document.addEventListener('keyup', onKey, { signal });
        // Browsers can drop pointerup on alt-tab / devtools — commit and tear down on focus loss.
        window.addEventListener('blur', commit, { signal });
    };

    const startRotate = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const ring = ringRef.current;
        if (!ring) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const controller = new AbortController();
        dragAbort.current = controller;
        const { signal } = controller;
        // Rotation preserves the center, so the ring's own bounding-box center IS the exact pivot
        // in screen space — no client↔scene mapping needed. Captured once at pointerdown: exact only
        // while the viewport is scroll-stable during the drag (both hosts freeze it; neither scrolls
        // the page), which is why onCommit documents that the host must freeze pan/zoom.
        const rect = ring.getBoundingClientRect();
        const pivotX = rect.left + rect.width / 2;
        const pivotY = rect.top + rect.height / 2;
        const snapshot = box;
        const startAngle = Math.atan2(e.clientY - pivotY, e.clientX - pivotX);
        const cursor = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey };
        let latest: Box | null = null;
        setRotating(true);
        setDragging(true);

        const update = () => {
            const angleRad = Math.atan2(cursor.clientY - pivotY, cursor.clientX - pivotX);
            const deltaDeg = ((angleRad - startAngle) * 180) / Math.PI;
            let angle = snapshot.angle + deltaDeg;
            if (cursor.shiftKey) angle = snapAngle(angle);
            const next = { ...snapshot, angle };
            latest = next;
            onTransform(next);
        };

        const onMove = (me: PointerEvent) => {
            cursor.clientX = me.clientX;
            cursor.clientY = me.clientY;
            cursor.shiftKey = me.shiftKey;
            update();
        };
        // Capture phase + stopPropagation on Escape — same layering discipline as startResize.
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key === 'Escape') {
                ke.preventDefault();
                ke.stopPropagation();
                return cancel();
            }
            if (ke.key !== 'Shift') return;
            cursor.shiftKey = ke.shiftKey;
            update();
        };
        const teardown = () => {
            setRotating(false);
            setDragging(false);
            controller.abort();
        };
        const commit = () => {
            teardown();
            if (latest && !sameBox(latest, snapshot)) onCommit({ ...latest, angle: normalizeAngle(latest.angle) });
        };
        const cancel = () => {
            teardown();
            onTransform(snapshot);
        };

        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', commit, { signal });
        document.addEventListener('pointercancel', commit, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
        document.addEventListener('keyup', onKey, { signal });
        window.addEventListener('blur', commit, { signal });
    };

    // Side grips gate on the on-screen box size. screenDeltaToScene is a uniform scale, so a
    // (1,1) probe gives scene-units-per-screen-px; dividing the scene size back out yields px.
    // Frozen open while dragging so a resize past the threshold can't unmount the active grip.
    const perPx = screenDeltaToScene(1, 1);
    const screenW = perPx.dx !== 0 ? box.width / perPx.dx : Number.POSITIVE_INFINITY;
    const screenH = perPx.dy !== 0 ? box.height / perPx.dy : Number.POSITIVE_INFINITY;
    const showSides = dragging || (screenW >= SIDE_GRIP_MIN_SCREEN_PX && screenH >= SIDE_GRIP_MIN_SCREEN_PX);

    return (
        <div
            ref={ringRef}
            className="absolute pointer-events-none eigen-selection-ring"
            style={{
                ...boxToStyle(box),
                transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                transformOrigin: 'center center',
            }}
        >
            {RESIZE_HANDLES.map(({ mode, position, cursorIndex, side }) =>
                side && !showSides ? null : (
                    <div
                        key={mode}
                        className={cn('eigen-selection-handle pointer-events-auto touch-none', position)}
                        style={{ cursor: cursorFor(cursorIndex, box.angle) }}
                        onPointerDown={(e) => startResize(e, mode)}
                    />
                ),
            )}
            {showRotate && (
                <>
                    <div className="absolute left-1/2 -translate-x-1/2 -top-6 h-6 w-px bg-selection-handle pointer-events-none" />
                    <div
                        className="absolute left-1/2 -translate-x-1/2 -top-9 flex h-4 w-4 items-center justify-center rounded-full bg-background border border-selection-handle pointer-events-auto cursor-grab touch-none"
                        onPointerDown={startRotate}
                    >
                        <RotateCw className="h-2.5 w-2.5 text-selection-handle" />
                    </div>
                </>
            )}
            {rotating && (
                // Counter-rotate so the pill stays upright while it orbits with the rotate grip.
                // The -box.angle cancels the ring's rotate() because both share the ring's default
                // transformOrigin (center) — keep them in sync if that origin ever changes.
                <div
                    className="absolute left-1/2 -top-16 pointer-events-none whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-xs text-background"
                    style={{ transform: `translateX(-50%) rotate(${-box.angle}deg)` }}
                >
                    {Math.round(normalizeAngle(box.angle))}°
                </div>
            )}
        </div>
    );
}
