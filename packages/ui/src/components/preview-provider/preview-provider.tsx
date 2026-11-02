// PreviewProvider holds the one quick-look preview an app shows, and renders it on <body> while it is open. Anything
// under it opens a file through usePreview, with the siblings the arrow keys page through.

import { subjectInfo } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type React from 'react';
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePreview } from '../drive/file-preview';
import { PreviewContext, useOptionalPreview, usePreview } from './preview-context';

// The hooks live in the ./preview-context leaf, so code inside the preview's own tree reads them without a cycle.
export { useOptionalPreview, usePreview };

type PreviewState = { subject: FileSubject; siblings: FileSubject[] };

export function PreviewProvider({ children }: { children: React.ReactNode }) {
    const [preview, setPreview] = useState<PreviewState | null>(null);

    const openPreview = useCallback((subject: FileSubject, siblings?: FileSubject[]) => {
        setPreview({ subject, siblings: siblings || [] });
    }, []);

    const updatePreview = useCallback((subject: FileSubject) => {
        setPreview((prev) => {
            if (!prev) return prev;
            return { ...prev, subject };
        });
    }, []);

    const closePreview = useCallback(() => {
        setPreview(null);
    }, []);

    const navigatePreview = useCallback((direction: -1 | 1) => {
        setPreview((prev) => {
            if (!prev || prev.siblings.length === 0) return prev;
            const key = subjectInfo(prev.subject).key;
            const currentIdx = prev.siblings.findIndex((sibling) => subjectInfo(sibling).key === key);
            if (currentIdx === -1) return prev;
            const nextIdx = currentIdx + direction;
            if (nextIdx < 0 || nextIdx >= prev.siblings.length) return prev;
            return { ...prev, subject: prev.siblings[nextIdx] };
        });
    }, []);

    return (
        <PreviewContext.Provider value={{ openPreview, updatePreview, closePreview, isPreviewOpen: preview !== null }}>
            {children}
            {/* On <body> like every Radix layer, so document order is stacking order (isLayerAbove). */}
            {preview &&
                createPortal(
                    <FilePreview
                        {...preview}
                        onClose={closePreview}
                        onPrev={() => navigatePreview(-1)}
                        onNext={() => navigatePreview(1)}
                    />,
                    document.body,
                )}
        </PreviewContext.Provider>
    );
}
