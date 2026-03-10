"use client"

import React, {createContext, useCallback, useContext, useState} from "react"
import type {DrivePath} from "@workspace/lib/types/drive"
import {getDriveEmbedUrl} from "@workspace/lib/api"
import {FilePreview} from "../drive/file-preview"

type PreviewState = {
    url: string;
    mimeType: string;
    aspectRatio?: number;
}

type PreviewContextValue = {
    openPreview: (path: DrivePath) => void;
    updatePreview: (path: DrivePath) => void;
    closePreview: () => void;
    isPreviewOpen: boolean;
    canPreview: (path: DrivePath) => boolean;
}

const PreviewContext = createContext<PreviewContextValue | undefined>(undefined)

function isPreviewable(path: DrivePath): boolean {
    const mime = path.mimeType || ""
    return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf"
}

function buildPreviewState(path: DrivePath): PreviewState | null {
    const mime = path.mimeType || ""
    if (!isPreviewable(path)) return null
    const url = getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name)
    const aspectRatio = path.details?.width && path.details?.height
        ? path.details.width / path.details.height
        : undefined
    return {url, mimeType: mime, aspectRatio}
}

export function PreviewProvider({children}: {children: React.ReactNode}) {
    const [preview, setPreview] = useState<PreviewState | null>(null)

    const openPreview = useCallback((path: DrivePath) => {
        const state = buildPreviewState(path)
        if (state) setPreview(state)
    }, [])

    const updatePreview = useCallback((path: DrivePath) => {
        setPreview(prev => {
            if (!prev) return prev
            const state = buildPreviewState(path)
            return state ?? null
        })
    }, [])

    const closePreview = useCallback(() => {
        setPreview(null)
    }, [])

    const canPreview = useCallback((path: DrivePath) => {
        return isPreviewable(path)
    }, [])

    return (
        <PreviewContext.Provider value={{openPreview, updatePreview, closePreview, isPreviewOpen: preview !== null, canPreview}}>
            {children}
            <FilePreview
                url={preview?.url || ''}
                mimeType={preview?.mimeType || ''}
                onClose={closePreview}
                open={preview !== null}
                aspectRatio={preview?.aspectRatio ? `${preview.aspectRatio}` : undefined}
            />
        </PreviewContext.Provider>
    )
}

export function usePreview() {
    const context = useContext(PreviewContext)
    if (!context) throw new Error("usePreview must be used within a PreviewProvider")
    return context
}
