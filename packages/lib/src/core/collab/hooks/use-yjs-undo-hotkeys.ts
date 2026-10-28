// Binds undo and redo to a Yjs UndoManager for an editor without its own keymap, such as a canvas or a Stickies
// board. The keys work anywhere on the page, for as long as the caller says the user may write.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useCallback, useMemo, useRef } from 'react';
import type * as Y from 'yjs';

// The keys every Eigen editor undoes and redoes with, which an Edit menu shows beside its rows.
export const UNDO_HOTKEY = 'Mod+Z';
export const REDO_HOTKEY = 'Mod+Shift+Z';

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
    useHotkey('Mod+Y', redo, options);
    useHotkey(REDO_HOTKEY, redo, options);
}
