// Binds undo and redo to a Yjs UndoManager for an editor without its own keymap, such as a canvas or a Stickies
// board. The keys work anywhere on the page, for as long as the caller says the user may write.

import { useHotkey } from '@tanstack/react-hotkeys';
import { REDO_ALT_HOTKEY, REDO_HOTKEY, UNDO_HOTKEY } from '@workspace/lib/constants/hotkeys';
import { useCallback, useMemo, useRef } from 'react';
import type * as Y from 'yjs';

export function useYjsUndoHotkeys(undoManager: Y.UndoManager | null, canWrite: boolean): void {
    const enabled = canWrite && !!undoManager;

    // Identity-stable handlers and options: an editor re-renders on every preview tick, and these
    // three registrations must not be rebuilt for that. The manager rides a ref instead of a closure.
    const managerRef = useRef(undoManager);
    managerRef.current = undoManager;
    const undo = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        managerRef.current?.undo();
    }, []);
    const redo = useCallback((e: KeyboardEvent) => {
        e.preventDefault();
        managerRef.current?.redo();
    }, []);
    const options = useMemo(() => ({ enabled }), [enabled]);

    useHotkey(UNDO_HOTKEY, undo, options);
    useHotkey(REDO_ALT_HOTKEY, redo, options);
    useHotkey(REDO_HOTKEY, redo, options);
}
