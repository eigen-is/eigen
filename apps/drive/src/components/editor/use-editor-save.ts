// The save story of Drive's inline editors: Mod+S, the dirty state and the "Discard changes?" their Cancel
// asks. Each save sends the etag the editor loaded, or the one its last save answered, so a file that
// changed since answers a conflict, which opens the conflict dialog. `atRisk` says a close would lose work:
// unsaved edits, or a save in flight, which may still fail. Cancel and the editor's leave guard ask while it holds.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useFileSave } from '@workspace/lib/editor';
import { useDiscardChanges } from '@workspace/ui/hooks/use-discard-changes';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';

type EditorSaveOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    etag: string;
    getContent: () => string;
    getFrontmatter?: () => string | undefined;
    onCancel: () => void;
};

type EditorSave = {
    saveState: SaveState;
    atRisk: boolean;
    showConflict: boolean;
    setShowConflict: (open: boolean) => void;
    markDirty: () => void;
    doSave: (force?: boolean) => Promise<boolean>;
    cancel: () => void;
    discardDialog: ReactNode;
};

export function useEditorSave({
    ownerId,
    mountId,
    pathId,
    etag,
    getContent,
    getFrontmatter,
    onCancel,
}: EditorSaveOptions): EditorSave {
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const [showConflict, setShowConflict] = useState(false);
    const etagRef = useRef(etag);
    // Counts edits, so a save that lands knows whether the user typed while it was in flight.
    const editsRef = useRef(0);
    const fileSave = useFileSave(ownerId, mountId, pathId);
    const unsaved = saveState === 'unsaved' || saveState === 'conflict';
    const atRisk = unsaved || saveState === 'saving';

    const markDirty = useCallback(() => {
        editsRef.current++;
        setSaveState('unsaved');
    }, []);

    const doSave = useCallback(
        async (force = false): Promise<boolean> => {
            if (!unsaved && !force) return true;
            const sentEdits = editsRef.current;
            setSaveState('saving');
            try {
                const result = await fileSave.mutateAsync({
                    content: getContent(),
                    frontmatter: getFrontmatter?.(),
                    expectedEtag: etagRef.current,
                    force,
                });
                if (result.conflict) {
                    setSaveState('conflict');
                    setShowConflict(true);
                    return false;
                }
                etagRef.current = result.etag;
                const current = editsRef.current === sentEdits;
                setSaveState(current ? 'saved' : 'unsaved');
                return current;
            } catch {
                setSaveState('unsaved');
                return false;
            }
        },
        [unsaved, fileSave, getContent, getFrontmatter],
    );

    useHotkey('Mod+S', (e) => {
        e.preventDefault();
        doSave();
    });

    // The editor is open while it is mounted, and a save in flight asks rather than waits, since it may fail.
    const discard = useDiscardChanges({ open: true, changed: atRisk, pending: false, onDiscard: onCancel });

    return {
        saveState,
        atRisk,
        showConflict,
        setShowConflict,
        markDirty,
        doSave,
        cancel: () => discard.onOpenChange(false),
        discardDialog: discard.dialog,
    };
}
