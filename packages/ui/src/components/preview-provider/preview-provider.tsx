import { getDrivePreviewUrl } from '@workspace/lib/api';
import { getPreviewMode } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { FilePreview } from '../drive/file-preview';
import type { PreviewOptions } from './preview-context';
import { PreviewContext, useOptionalPreview, usePreview } from './preview-context';

// The context object and the usePreview/useOptionalPreview hooks live in the
// feature-tree-free ./preview-context leaf so Dialog can read the preview flag
// without importing this module. Re-exported here so existing consumers keep their
// import path.
export { useOptionalPreview, usePreview };

type PreviewState = {
    subject: FileSubject;
    siblings: FileSubject[];
    attachment: boolean;
};

export function PreviewProvider({ children }: { children: React.ReactNode }) {
    const [preview, setPreview] = useState<PreviewState | null>(null);

    const openPreview = useCallback((subject: FileSubject, siblings?: FileSubject[], options?: PreviewOptions) => {
        setPreview({ subject, siblings: siblings || [], attachment: options?.attachment ?? false });
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
            const currentIdx = prev.siblings.findIndex((s) => s.key === prev.subject.key);
            if (currentIdx === -1) return prev;
            const nextIdx = currentIdx + direction;
            if (nextIdx < 0 || nextIdx >= prev.siblings.length) return prev;
            return { ...prev, subject: prev.siblings[nextIdx] };
        });
    }, []);

    const previewProps = useMemo(() => {
        if (!preview) return null;
        const { subject } = preview;
        const { drive } = subject;
        const updated = drive && (drive.updatedAt instanceof Date ? drive.updatedAt : new Date(drive.updatedAt));
        // The transcode route is a Drive item's alone; anything else previews the bytes it embeds.
        const previewUrl = drive
            ? getDrivePreviewUrl(drive.ownerId, drive.mountId, drive.id, updated)
            : subject.embedUrl;
        const aspectRatio =
            drive?.details?.width && drive.details.height ? drive.details.width / drive.details.height : undefined;

        const currentIdx = preview.siblings.findIndex((s) => s.key === subject.key);
        const hasPrev = currentIdx > 0;
        const hasNext = currentIdx >= 0 && currentIdx < preview.siblings.length - 1;

        return {
            previewMode: getPreviewMode(subject),
            previewUrl,
            aspectRatio,
            hasPrev,
            hasNext,
            subject,
            siblings: preview.siblings,
            attachment: preview.attachment,
        };
    }, [preview]);

    return (
        <PreviewContext.Provider value={{ openPreview, updatePreview, closePreview, isPreviewOpen: preview !== null }}>
            {children}
            {previewProps && (
                <FilePreview
                    {...previewProps}
                    onClose={closePreview}
                    onPrev={() => navigatePreview(-1)}
                    onNext={() => navigatePreview(1)}
                />
            )}
        </PreviewContext.Provider>
    );
}
