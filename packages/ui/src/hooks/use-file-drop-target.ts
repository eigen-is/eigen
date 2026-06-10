import { useCallback } from 'react';

// OS-file drop target — the complement of use-list-drop-target, which handles
// internal `application/eigen-drag` payloads. Spread the returned props on any
// container to stage dropped files.
export function useFileDropTarget(onFiles: (files: File[]) => void, enabled = true) {
    const onDragOver = useCallback(
        (e: React.DragEvent) => {
            if (!enabled || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        },
        [enabled],
    );

    const onDrop = useCallback(
        (e: React.DragEvent) => {
            if (!enabled) return;
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            e.preventDefault();
            onFiles(files);
        },
        [enabled, onFiles],
    );

    return { onDragOver, onDrop };
}
