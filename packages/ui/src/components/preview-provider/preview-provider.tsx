import { subjectInfo } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type React from 'react';
import { useCallback, useState } from 'react';
import { FilePreview } from '../drive/file-preview';
import { PreviewContext, useOptionalPreview, usePreview } from './preview-context';

// The hooks live in the feature-tree-free ./preview-context leaf so Dialog can read the preview flag.
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
            {preview && (
                <FilePreview
                    {...preview}
                    onClose={closePreview}
                    onPrev={() => navigatePreview(-1)}
                    onNext={() => navigatePreview(1)}
                />
            )}
        </PreviewContext.Provider>
    );
}
