import {useCallback, useEffect, useRef, useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {useFileSave} from '@workspace/lib/editor';

type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';

type EditorSaveOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    updatedAt: string;
    getContent: () => string;
    getFrontmatter?: () => string | undefined;
};

export function useEditorSave({ownerId, mountId, pathId, updatedAt, getContent, getFrontmatter}: EditorSaveOptions) {
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const [showConflict, setShowConflict] = useState(false);
    const updatedAtRef = useRef(updatedAt);
    const isDirtyRef = useRef(false);
    const fileSave = useFileSave(ownerId, mountId, pathId);

    const markDirty = useCallback(() => {
        isDirtyRef.current = true;
        setSaveState('unsaved');
    }, []);

    const doSave = useCallback(async (force = false): Promise<boolean> => {
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
    }, [fileSave, getContent, getFrontmatter]);

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

    const confirmClose = (onClose: () => void) => {
        if (isDirtyRef.current && !window.confirm('You have unsaved changes. Discard?')) return;
        onClose();
    };

    return {
        saveState,
        showConflict,
        setShowConflict,
        markDirty,
        doSave,
        confirmClose,
    };
}
