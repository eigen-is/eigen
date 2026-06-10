import { useHotkey } from '@tanstack/react-hotkeys';
import type * as Y from 'yjs';

export function useYjsUndoHotkeys(undoManager: Y.UndoManager | null, canWrite: boolean): void {
    const enabled = canWrite && !!undoManager;

    useHotkey(
        'Mod+Z',
        (e) => {
            e.preventDefault();
            undoManager?.undo();
        },
        { enabled },
    );
    useHotkey(
        'Mod+Y',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled },
    );
    useHotkey(
        'Mod+Shift+Z',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled },
    );
}
