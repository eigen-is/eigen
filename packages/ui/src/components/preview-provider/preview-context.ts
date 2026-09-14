import type { FileSubject } from '@workspace/lib/types/file-subject';
import { createContext, useContext } from 'react';

// Leaf module for the preview context so the base Dialog primitive can read the
// "is a preview open" flag without importing PreviewProvider — which pulls in the
// whole Drive feature tree (FilePreview → DriveLocationPicker → Dialog) and closes
// an import cycle back onto Dialog. This file must import nothing from that tree.

export type PreviewOptions = { attachment?: boolean };

export type PreviewContextValue = {
    // `attachment` marks the subjects as one container's attachments rather than files at a Drive
    // location: a set to act on as a whole, drawing "Save all (n)", and a set whose Drive copies sit
    // in a hidden media folder, so a convert saves to a folder the user picks before it runs. A Drive
    // listing handing over its whole folder for navigation passes nothing.
    openPreview: (subject: FileSubject, siblings?: FileSubject[], options?: PreviewOptions) => void;
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
