import { useHotkey } from '@tanstack/react-hotkeys';
import { useFileSave } from '@workspace/lib/editor';
import { useCallback, useEffect, useRef, useState } from 'react';

type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';

type EditorSaveOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    updatedAt: Date;
    getContent: () => string;
    getFrontmatter?: () => string | undefined;
};

export function useEditorSave({ ownerId, mountId, pathId, updatedAt, getContent, getFrontmatter }: EditorSaveOptions) {
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const [showConflict, setShowConflict] = useState(false);
    const updatedAtRef = useRef(updatedAt);
    const isDirtyRef = useRef(false);
    const fileSave = useFileSave(ownerId, mountId, pathId);

    const markDirty = useCallback(() => {
        isDirtyRef.current = true;
        setSaveState('unsaved');
    }, []);

    const doSave = useCallback(
        async (force = false): Promise<boolean> => {
            if (!isDirtyRef.current && !force) return true;
            setSaveState('saving');
            try {
                const result = await fileSave.mutateAsync({
                    content: getContent(),
                    frontmatter: getFrontmatter?.(),
                    expectedUpdatedAt: updatedAtRef.current,
                    force,
                });
                if (result.conflict) {
                    setSaveState('conflict');
                    setShowConflict(true);
                    return false;
                }
                if (result.updatedAt) updatedAtRef.current = result.updatedAt;
                isDirtyRef.current = false;
                setSaveState('saved');
                return true;
            } catch {
                setSaveState('unsaved');
                return false;
            }
        },
        [fileSave, getContent, getFrontmatter],
    );

    useHotkey('Mod+S', (e) => {
        e.preventDefault();
        doSave();
    });

    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (isDirtyRef.current) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    const pendingCloseRef = useRef<(() => void) | null>(null);

    const confirmClose = useCallback((onClose: () => void) => {
        if (!isDirtyRef.current) {
            onClose();
            return;
        }
        pendingCloseRef.current = onClose;
        setShowDiscardConfirm(true);
    }, []);

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
