// The save story of Drive's inline editors: Mod+S, the dirty state and the discard dialog their Cancel
// opens. Each save sends the etag the editor loaded, or the one its last save answered, so a file that
// changed since answers a conflict, which opens the conflict dialog. `unsaved` says whether there is
// work to save; `atRisk` adds a save in flight, which a leave guard must not drop since that save may fail.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useFileSave } from '@workspace/lib/editor';
import { useCallback, useRef, useState } from 'react';

type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';

type EditorSaveOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    etag: string;
    getContent: () => string;
    getFrontmatter?: () => string | undefined;
};

type EditorSave = {
    saveState: SaveState;
    unsaved: boolean;
    atRisk: boolean;
    showConflict: boolean;
    setShowConflict: (open: boolean) => void;
    markDirty: () => void;
    doSave: (force?: boolean) => Promise<boolean>;
    confirmClose: (onClose: () => void) => void;
    showDiscardConfirm: boolean;
    handleDiscardConfirm: () => void;
    handleDiscardCancel: () => void;
};

export function useEditorSave({
    ownerId,
    mountId,
    pathId,
    etag,
    getContent,
    getFrontmatter,
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

    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    const pendingCloseRef = useRef<(() => void) | null>(null);

    const confirmClose = useCallback(
        (onClose: () => void) => {
            if (!atRisk) {
                onClose();
                return;
            }
            pendingCloseRef.current = onClose;
            setShowDiscardConfirm(true);
        },
        [atRisk],
    );

    const handleDiscardConfirm = useCallback(() => {
        setShowDiscardConfirm(false);
        pendingCloseRef.current?.();
        pendingCloseRef.current = null;
    }, []);

    const handleDiscardCancel = useCallback(() => {
        setShowDiscardConfirm(false);
        pendingCloseRef.current = null;
    }, []);

    return {
        saveState,
        unsaved,
        atRisk,
        showConflict,
        setShowConflict,
        markDirty,
        doSave,
        confirmClose,
        showDiscardConfirm,
        handleDiscardConfirm,
        handleDiscardCancel,
    };
}
