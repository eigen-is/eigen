import type { DrivePath } from '@workspace/lib/types/drive';
import { createContext, useContext } from 'react';

// Leaf module for the preview context so the base Dialog primitive can read the
// "is a preview open" flag without importing PreviewProvider — which pulls in the
// whole Drive feature tree (FilePreview → DriveLocationPicker → Dialog) and closes
// an import cycle back onto Dialog. This file must import nothing from that tree.

export type DownloadMode = 'direct' | 'save-to-drive';

export type PreviewOptions = {
    downloadMode?: DownloadMode;
};

export type PreviewContextValue = {
    openPreview: (path: DrivePath, siblings?: DrivePath[], options?: PreviewOptions) => void;
    updatePreview: (path: DrivePath) => void;
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
