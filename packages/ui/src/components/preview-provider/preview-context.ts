import type { FileSubject } from '@workspace/lib/types/file-subject';
import { createContext, useContext } from 'react';

// Leaf module for the preview context so the base Dialog primitive can read the
// "is a preview open" flag without importing PreviewProvider — which pulls in the
// whole Drive feature tree (FilePreview → DriveLocationPicker → Dialog) and closes
// an import cycle back onto Dialog. This file must import nothing from that tree.

export type PreviewContextValue = {
    // `batch` marks the siblings as a set the overlay may act on as a whole (an attachment list), so
    // a Drive listing handing over its whole folder for navigation gets no "Download all" row.
    openPreview: (subject: FileSubject, siblings?: FileSubject[], options?: { batch?: boolean }) => void;
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
