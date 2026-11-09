// A long press on touch opens a row's or card's context menu where the browser sends no `contextmenu`, such as
// iOS or a `touch-none` drag surface. A still press fires after LONG_PRESS_MS, a move past MOVE_CANCEL_PX
// cancels it, and mouse and pen keep their right-click. One instance serves a whole list: `bind(item)` gives
// each row its handlers. Where Chromium also sends a native menu at the same spot, the second open just wins.

import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

// A callback that returns false opened nothing, so its press leaves the click that follows alone.
export function useLongPress<T>(
    onLongPress: (item: T, x: number, y: number) => unknown,
    opts?: { disabled?: boolean },
) {
    const disabled = opts?.disabled ?? false;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const fired = useRef(false);

    const cancel = useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        start.current = null;
    }, []);

    // A disable mid-press, such as losing write access, drops the pending timer.
    useEffect(() => {
        if (disabled) cancel();
    }, [disabled, cancel]);

    // The host's unmount drops the timer. For a list-level instance a row removed mid-press still fires, for a
    // stale item whose actions fail harmlessly.
    useEffect(() => cancel, [cancel]);

    const bind = useCallback(
        (item: T) => ({
            onPointerDown: (e: React.PointerEvent) => {
                // Every pointer type clears a second finger's pending timer and a leftover fired flag, which a
                // native contextmenu can leave by eating the click that resets it.
                cancel();
                fired.current = false;
                if (disabled || e.pointerType !== 'touch') return;
                const x = e.clientX;
                const y = e.clientY;
                start.current = { x, y };
                timer.current = setTimeout(() => {
                    timer.current = null;
                    // At the press's start: any drift is under MOVE_CANCEL_PX, or the press was canceled.
                    fired.current = onLongPress(item, x, y) !== false;
                }, LONG_PRESS_MS);
            },
            onPointerMove: (e: React.PointerEvent) => {
                if (!start.current) return;
                const dx = e.clientX - start.current.x;
                const dy = e.clientY - start.current.y;
                if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancel();
            },
            onPointerUp: cancel,
            onPointerCancel: cancel,
            // Swallows the click a fired press leaves behind, in the capture phase so it beats the row's onClick.
            onClickCapture: (e: React.MouseEvent) => {
                if (!fired.current) return;
                e.preventDefault();
                e.stopPropagation();
                fired.current = false;
            },
        }),
        [disabled, onLongPress, cancel],
    );

    return { bind };
}
