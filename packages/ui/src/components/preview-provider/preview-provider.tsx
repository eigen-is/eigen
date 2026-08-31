import { getDriveDownloadUrl, getDriveEmbedUrl, getDrivePreviewUrl, getDriveThumbnailUrl } from '@workspace/lib/api';
import { getTextPreviewMode, isExiftoolExtension } from '@workspace/lib/constants';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_VECTOR, isFolderType } from '@workspace/lib/types/drive';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { FilePreview } from '../drive/file-preview';
import {
    type DownloadMode,
    PreviewContext,
    type PreviewOptions,
    useOptionalPreview,
    usePreview,
} from './preview-context';

// The context object and the usePreview/useOptionalPreview hooks live in the
// feature-tree-free ./preview-context leaf so Dialog can read the preview flag
// without importing this module. Re-exported here so existing consumers keep their
// import path.
export type { DownloadMode, PreviewOptions };
export { useOptionalPreview, usePreview };

type PreviewState = {
    path: DrivePath;
    siblings: DrivePath[];
    downloadMode: DownloadMode;
};

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'fallback';

function getPreviewMode(path: DrivePath): PreviewMode {
    const mime = path.mimeType || '';

    // A vector doc previews as the SVG the server renders, served as an image.
    if (mime === DRIVE_MIME_VECTOR || mime.startsWith('image/') || isExiftoolExtension(path.name)) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (getTextPreviewMode(mime, path.name) !== null) return 'text';
    return 'fallback';
}

export function PreviewProvider({ children }: { children: React.ReactNode }) {
    const [preview, setPreview] = useState<PreviewState | null>(null);

    const openPreview = useCallback((path: DrivePath, siblings?: DrivePath[], options?: PreviewOptions) => {
        setPreview({ path, siblings: siblings || [], downloadMode: options?.downloadMode ?? 'direct' });
    }, []);

    const updatePreview = useCallback((path: DrivePath) => {
        setPreview((prev) => {
            if (!prev) return prev;
            return { ...prev, path };
        });
    }, []);

    const closePreview = useCallback(() => {
        setPreview(null);
    }, []);

    const navigatePreview = useCallback((direction: -1 | 1) => {
        setPreview((prev) => {
            if (!prev || prev.siblings.length === 0) return prev;
            const currentIdx = prev.siblings.findIndex((s) => s.id === prev.path.id);
            if (currentIdx === -1) return prev;
            const nextIdx = currentIdx + direction;
            if (nextIdx < 0 || nextIdx >= prev.siblings.length) return prev;
            return { ...prev, path: prev.siblings[nextIdx] };
        });
    }, []);

    const previewProps = useMemo(() => {
        if (!preview) return null;
        const mode = getPreviewMode(preview.path);

        const { path } = preview;
        const updated = path.updatedAt instanceof Date ? path.updatedAt : new Date(path.updatedAt);
        const previewUrl = getDrivePreviewUrl(path.ownerId, path.mountId, path.id, updated);
        const embedUrl = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name, updated);
        const downloadUrl = isFolderType(path.type)
            ? undefined
            : getDriveDownloadUrl(path.ownerId, path.mountId, path.id, updated);
        const thumbnailUrl = path.thumbnail
            ? getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail, updated)
            : undefined;
        const aspectRatio =
            path.details?.width && path.details?.height ? path.details.width / path.details.height : undefined;

        const currentIdx = preview.siblings.findIndex((s) => s.id === path.id);
        const hasPrev = currentIdx > 0;
        const hasNext = currentIdx >= 0 && currentIdx < preview.siblings.length - 1;

        return {
            previewMode: mode,
            previewUrl,
            thumbnailUrl,
            embedUrl,
            downloadUrl,
            fileName: path.name,
            aspectRatio,
            hasPrev,
            hasNext,
            path,
            downloadMode: preview.downloadMode,
            siblings: preview.siblings,
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
