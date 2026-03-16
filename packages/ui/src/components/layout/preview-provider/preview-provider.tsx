"use client"

import React, {createContext, useCallback, useContext, useMemo, useState} from "react"
import type {DrivePath} from "@workspace/lib/types/drive"
import {isFolderType} from "@workspace/lib/types/drive"
import {getDriveDownloadUrl, getDriveEmbedUrl, getDrivePreviewUrl} from "@workspace/lib/api"
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
    canPreview: (path: DrivePath) => boolean;
}

const PreviewContext = createContext<PreviewContextValue | undefined>(undefined)

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'fallback';

const CODE_EXTENSIONS = new Set([
    '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.csv',
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
    '.py', '.rs', '.go', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
    '.swift', '.kt', '.scala', '.sql', '.graphql', '.gql',
    '.sh', '.bash', '.zsh', '.fish', '.conf', '.cfg', '.ini', '.toml',
    '.env', '.gitignore', '.dockerignore', '.editorconfig',
    '.log', '.diff', '.patch', '.svelte', '.vue', '.astro', '.dockerfile',
    '.r', '.lua', '.zig', '.dart',
]);

const EXIFTOOL_EXTENSIONS = new Set([
    '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw', '.rwl',
    '.psd', '.psb', '.ai', '.heic', '.heif',
]);

function getPreviewMode(path: DrivePath): PreviewMode {
    const mime = path.mimeType || "";
    const ext = path.name.slice(path.name.lastIndexOf('.')).toLowerCase();

    // Standard images → always previewable via sharp
    if (mime.startsWith("image/") && !EXIFTOOL_EXTENSIONS.has(ext)) return 'image';

    // Exiftool formats → only if thumbnail exists (extraction may have failed)
    if (EXIFTOOL_EXTENSIONS.has(ext)) {
        return path.thumbnail ? 'image' : 'fallback';
    }

    if (mime.startsWith("video/")) return 'video';
    if (mime.startsWith("audio/")) return 'audio';
    if (mime === "application/pdf") return 'pdf';

    // Text/code/markdown → html preview
    if (mime === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'html';
    if (mime === 'text/plain' || ext === '.txt') return 'html';
    if (mime.startsWith('text/') || mime.startsWith('application/json') ||
        mime.startsWith('application/javascript') || mime.startsWith('application/typescript') ||
        mime.startsWith('application/xml') || mime.startsWith('application/x-yaml') ||
        mime.startsWith('application/x-sh') || mime.startsWith('application/toml')) return 'html';
    if (CODE_EXTENSIONS.has(ext)) return 'html';

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

    const canPreview = useCallback((_path: DrivePath) => {
        return true;
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
        const previewUrl = getDrivePreviewUrl(path.ownerId, path.mountId, path.id);
        const embedUrl = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name);
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
            mimeType: path.mimeType,
            aspectRatio,
            hasPrev,
            hasNext,
            path,
        };
    }, [preview]);

    return (
        <PreviewContext.Provider value={{openPreview, updatePreview, closePreview, isPreviewOpen: preview !== null, canPreview}}>
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
