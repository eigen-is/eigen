import { useCallback } from 'react';

// A text+files clipboard (e.g. copied Excel cells) should still paste its text
// into the focused field; only a files-only clipboard is swallowed by attach flows.
export function isFilesOnlyClipboard(data: DataTransfer) {
    return data.files.length > 0 && !data.types.includes('text/plain');
}

// OS-file paste target — hands pasted files to `onFiles`, the complement of
// use-file-drop-target for the same attach flows.
export function useFilePasteTarget(onFiles: (files: File[]) => void, enabled = true) {
    const onPaste = useCallback(
        (e: React.ClipboardEvent) => {
            if (!enabled) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            if (isFilesOnlyClipboard(e.clipboardData)) e.preventDefault();
            onFiles(files);
        },
        [enabled, onFiles],
    );

    return { onPaste };
}
