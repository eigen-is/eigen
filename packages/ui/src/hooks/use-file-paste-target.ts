import { useCallback } from 'react';

// OS-file paste target — hands pasted files to `onFiles`, the complement of
// use-file-drop-target for the same attach flows. A text+files clipboard still
// pastes its text; only a files-only clipboard is swallowed.
export function useFilePasteTarget(onFiles: (files: File[]) => void, enabled = true) {
    const onPaste = useCallback(
        (e: React.ClipboardEvent) => {
            if (!enabled) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
            onFiles(files);
        },
        [enabled, onFiles],
    );

    return { onPaste };
}
