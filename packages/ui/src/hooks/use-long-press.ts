import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

// Long-press opens the singleton context menus on touch surfaces where the browser
// never synthesises a `contextmenu` (WebKit/iOS, or anywhere `touch-none` suppresses
// native synthesis). Touch only: mouse and pen keep their native right-click behaviour.
// A stationary press for LONG_PRESS_MS fires; any move past MOVE_CANCEL_PX (scroll/drag)
// cancels it. On Chromium a stationary press may ALSO synthesise a native contextmenu that
// the surface routes to the same menu at (near-)identical coords — a harmless double-fire,
// last write wins; the hook stays deliberately minimal and adds no cross-handler guard.
const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

export function useLongPress(onLongPress: (x: number, y: number) => void, opts?: { disabled?: boolean }) {
    const disabled = opts?.disabled ?? false;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const current = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const fired = useRef(false);

    const cancel = useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        start.current = null;
    }, []);

    // A mid-press disable (e.g. the row/card losing write access) must drop the pending timer.
    useEffect(() => {
        if (disabled) cancel();
    }, [disabled, cancel]);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (disabled || e.pointerType !== 'touch') return;
            fired.current = false;
            start.current = { x: e.clientX, y: e.clientY };
            current.current = { x: e.clientX, y: e.clientY };
            timer.current = setTimeout(() => {
                timer.current = null;
                fired.current = true;
                onLongPress(current.current.x, current.current.y);
            }, LONG_PRESS_MS);
        },
        [disabled, onLongPress],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!start.current) return;
            current.current = { x: e.clientX, y: e.clientY };
            const dx = e.clientX - start.current.x;
            const dy = e.clientY - start.current.y;
            if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancel();
        },
        [cancel],
    );

    const onPointerUp = useCallback(() => cancel(), [cancel]);
    const onPointerCancel = useCallback(() => cancel(), [cancel]);

    // Swallow the click that a fired long-press leaves behind, so it can't also
    // activate the row/card underneath. Capture phase, so it beats the element's onClick.
    const onClickCapture = useCallback((e: React.MouseEvent) => {
        if (!fired.current) return;
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
    }, []);

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
}
