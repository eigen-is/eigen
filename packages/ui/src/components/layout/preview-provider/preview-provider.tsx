"use client"

import React, {createContext, useCallback, useContext, useMemo, useState} from "react"
import type {DrivePath} from "@workspace/lib/types/drive"
import {isFolderType} from "@workspace/lib/types/drive"
import {getDriveDownloadUrl, getDriveEmbedUrl, getDrivePreviewUrl} from "@workspace/lib/api"
import {getTextPreviewMode, isExiftoolExtension} from "@workspace/lib/constants"
import {FilePreview} from "../drive/file-preview"

type PreviewState = {
    path: DrivePath;
    siblings: DrivePath[];
}

type PreviewContextValue = {
    openPreview: (path: DrivePath, siblings?: DrivePath[]) => void;
    updatePreview: (path: DrivePath) => void;
    closePreview: () => void;
    isPreviewOpen: boolean;
}

const PreviewContext = createContext<PreviewContextValue | undefined>(undefined)

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'fallback';

function getPreviewMode(path: DrivePath): PreviewMode {
    const mime = path.mimeType || "";

    if (mime.startsWith("image/") && !isExiftoolExtension(path.name)) return 'image';
    if (isExiftoolExtension(path.name)) return path.thumbnail ? 'image' : 'fallback';
    if (mime.startsWith("video/")) return 'video';
    if (mime.startsWith("audio/")) return 'audio';
    if (mime === "application/pdf") return 'pdf';
    if (getTextPreviewMode(mime, path.name) !== null) return 'html';
    return 'fallback';
}

export function PreviewProvider({children}: {children: React.ReactNode}) {
    const [preview, setPreview] = useState<PreviewState | null>(null)

    const openPreview = useCallback((path: DrivePath, siblings?: DrivePath[]) => {
        setPreview({path, siblings: siblings || []});
    }, [])

    const updatePreview = useCallback((path: DrivePath) => {
        setPreview(prev => {
            if (!prev) return prev;
            return {...prev, path};
        })
    }, [])

    const closePreview = useCallback(() => {
        setPreview(null)
    }, [])

    const navigatePreview = useCallback((direction: -1 | 1) => {
        setPreview(prev => {
            if (!prev || prev.siblings.length === 0) return prev;
            const currentIdx = prev.siblings.findIndex(s => s.id === prev.path.id);
            if (currentIdx === -1) return prev;
            const nextIdx = currentIdx + direction;
            if (nextIdx < 0 || nextIdx >= prev.siblings.length) return prev;
            return {...prev, path: prev.siblings[nextIdx]};
        });
    }, [])

    const previewProps = useMemo(() => {
        if (!preview) return null;
        const mode = getPreviewMode(preview.path);

        const {path} = preview;
        const v = path.updatedAt instanceof Date ? path.updatedAt.getTime() : new Date(path.updatedAt).getTime();
        const previewUrl = `${getDrivePreviewUrl(path.ownerId, path.mountId, path.id)}?v=${v}`;
        const embedUrl = `${getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name)}?v=${v}`;
        const downloadUrl = isFolderType(path.type) ? undefined : getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
        const aspectRatio = path.details?.width && path.details?.height
            ? path.details.width / path.details.height
            : undefined;

        const currentIdx = preview.siblings.findIndex(s => s.id === path.id);
        const hasPrev = currentIdx > 0;
        const hasNext = currentIdx >= 0 && currentIdx < preview.siblings.length - 1;

        return {
            previewMode: mode,
            previewUrl,
            embedUrl,
            downloadUrl,
            fileName: path.name,
            aspectRatio,
            hasPrev,
            hasNext,
            path,
        };
    }, [preview]);

    return (
        <PreviewContext.Provider value={{openPreview, updatePreview, closePreview, isPreviewOpen: preview !== null}}>
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
    )
}

export function usePreview() {
    const context = useContext(PreviewContext)
    if (!context) throw new Error("usePreview must be used within a PreviewProvider")
    return context
}
