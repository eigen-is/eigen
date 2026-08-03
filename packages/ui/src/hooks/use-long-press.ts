import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

// Long-press opens the singleton context menus on touch surfaces where the browser
// never synthesises a `contextmenu` (WebKit/iOS, or anywhere `touch-none` suppresses
// native synthesis). Touch only: mouse and pen keep their native right-click behaviour.
// A stationary press for LONG_PRESS_MS fires; any move past MOVE_CANCEL_PX (scroll/drag)
// cancels it. On Chromium a stationary press may ALSO synthesise a native contextmenu that
// the surface routes to the same menu at (near-)identical coords — a harmless double-fire,
// last write wins; the hook stays deliberately minimal and adds no cross-handler guard.
//
// One instance serves many rows: `bind(item)` returns the spreadable handlers for a given
// row/card and stashes its item on pointerdown, so the fire knows which one to open without
// an external per-row ref (mail/slides map rows inline; the drive views hoist one instance).
const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

export function useLongPress<T>(onLongPress: (item: T, x: number, y: number) => void, opts?: { disabled?: boolean }) {
    const disabled = opts?.disabled ?? false;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const pressed = useRef<{ item: T } | null>(null);
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

    // Cancel a pending timer when the component HOSTING this hook unmounts. For the list-level
    // instances (drive-table, drive-grid, email-list, slide-panel, SheetOverlay) that host is the
    // whole list, so this covers the list going away — not one row: a single row removed mid-press
    // (data refresh, a collaborator's delete) inside the 500 ms window is an accepted narrow race.
    // Its bound handlers vanish with its DOM but the armed timer still fires, opening the menu for a
    // now-stale item whose actions fail gracefully. Per-row hosts (stickies) get true per-row teardown.
    useEffect(() => cancel, [cancel]);

    const bind = useCallback(
        (item: T) => ({
            onPointerDown: (e: React.PointerEvent) => {
                // Runs for every pointer type: cancel a still-pending timer so a second finger on a
                // shared list-level instance can't orphan the first (pointerup/cancel would then never
                // reach it), and clear a leftover fired flag so it can't swallow a later click — the
                // native contextmenu can eat the compat click that would otherwise reset it. Arming
                // stays touch-only.
                cancel();
                fired.current = false;
                if (disabled || e.pointerType !== 'touch') return;
                const x = e.clientX;
                const y = e.clientY;
                start.current = { x, y };
                pressed.current = { item };
                timer.current = setTimeout(() => {
                    timer.current = null;
                    fired.current = true;
                    // Fire at the press-start coords: a move past MOVE_CANCEL_PX has already cancelled,
                    // so the drift from finger jitter is sub-threshold and imperceptible.
                    onLongPress(pressed.current!.item, x, y);
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
            // Swallow the click that a fired long-press leaves behind, so it can't also
            // activate the row/card underneath. Capture phase, so it beats the element's onClick.
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
