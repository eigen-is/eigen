import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export function useYjsUndoState(undoManager: Y.UndoManager | null, canWrite: boolean) {
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);

    useEffect(() => {
        if (!undoManager?.undoStack || !canWrite) {
            setCanUndo(false);
            setCanRedo(false);
            return;
        }
        const update = () => {
            setCanUndo(undoManager.undoStack.length > 0);
            setCanRedo(undoManager.redoStack.length > 0);
        };
        update();
        undoManager.on('stack-item-added', update);
        undoManager.on('stack-item-popped', update);
        undoManager.on('stack-item-updated', update);
        return () => {
            undoManager.off('stack-item-added', update);
            undoManager.off('stack-item-popped', update);
            undoManager.off('stack-item-updated', update);
        };
    }, [undoManager, canWrite]);

    return {
        canUndo,
        canRedo,
        undo: () => undoManager?.undo?.(),
        redo: () => undoManager?.redo?.(),
    };
}
