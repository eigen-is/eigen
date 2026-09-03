import { useHotkey } from '@tanstack/react-hotkeys';
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

    useHotkey('Mod+Z', undo, options);
    useHotkey('Mod+Y', redo, options);
    useHotkey('Mod+Shift+Z', redo, options);
}
