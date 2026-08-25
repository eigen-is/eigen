import { useCallback, useRef, useState } from 'react';

// OS-file drop target — the complement of use-list-drop-target, which handles
// internal `application/eigen-drag` payloads. Spread `targetProps` on any
// container to stage dropped files; `isDragging` drives a drop overlay.
// `onFiles` gets the drop `DragEvent` as an optional second arg so a positional
// consumer (the vector canvas) can map the drop point; every other consumer ignores it.
export function useFileDropTarget(onFiles: (files: File[], e?: React.DragEvent) => void, enabled = true) {
    const [isDragging, setIsDragging] = useState(false);
    // Depth-count enter/leave so nested children don't clear the overlay mid-drag.
    const dragDepth = useRef(0);

    const onDragEnter = useCallback(
        (e: React.DragEvent) => {
            if (!enabled || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            dragDepth.current += 1;
            setIsDragging(true);
        },
        [enabled],
    );

    const onDragLeave = useCallback(
        (e: React.DragEvent) => {
            if (!enabled || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
                dragDepth.current = 0;
                setIsDragging(false);
            }
        },
        [enabled],
    );

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
            dragDepth.current = 0;
            setIsDragging(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            e.preventDefault();
            onFiles(files, e);
        },
        [enabled, onFiles],
    );

    return { targetProps: { onDragEnter, onDragLeave, onDragOver, onDrop }, isDragging };
}
