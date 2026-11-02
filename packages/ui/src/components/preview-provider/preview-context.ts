// The quick-look context: open, page and close the file preview, and say whether one is open. It lives apart from
// PreviewProvider, which renders the preview and so pulls in the whole Drive tree. Code inside that tree, such as the
// file action runner, reads the context from here without an import cycle, so this file imports nothing from it.

import type { FileSubject } from '@workspace/lib/types/file-subject';
import { createContext, useContext } from 'react';

export type PreviewContextValue = {
    openPreview: (subject: FileSubject, siblings?: FileSubject[]) => void;
    updatePreview: (subject: FileSubject) => void;
    closePreview: () => void;
    isPreviewOpen: boolean;
};

export const PreviewContext = createContext<PreviewContextValue | undefined>(undefined);

export function usePreview() {
    const context = useContext(PreviewContext);
    if (!context) throw new Error('usePreview must be used within a PreviewProvider');
    return context;
}

export function useOptionalPreview() {
    return useContext(PreviewContext);
}
