import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { DrivePath } from '../../types/drive';
import { getDrivePreviewUrl } from '../api';
import { useFolderLookup } from './hooks/reads';
import { useUploadFile } from './hooks/writes';

// The optimistic-insert sentinel: a media name that exists only in this tab until its upload lands.
// Exported because every host that adds an image optimistically writes one (vector's paste paths).
export const PENDING_PREFIX = 'pending:';

export function isPendingMediaName(name: string): boolean {
    return name.startsWith(PENDING_PREFIX);
}

// URL for a file we already hold the DrivePath of — a fresh copy/upload result. By-NAME resolution
// goes through the media-folder listing, which still predates that write, so it would miss and hand
// back null; the path is authoritative right now. Use this whenever a mutation just returned the
// path, and keep the by-name resolver for render (a name is all Yjs stores, and it self-heals).
function resolveMediaUrlByPath(path: DrivePath): string {
    return getDrivePreviewUrl(path.ownerId, path.mountId, path.id, path.updatedAt);
}

type MediaResolverValue = {
    resolveMediaUrl: (name: string) => string | null;
    resolveMediaUrlByPath: (path: DrivePath) => string;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveChatId: (name: string) => string | null;
    mediaFolderId: string | null;
    startUpload: (file: File) => { pendingName: string; promise: Promise<DrivePath | null> };
};

const MediaResolverContext = createContext<MediaResolverValue>({
    resolveMediaUrl: () => null,
    resolveMediaUrlByPath,
    resolveMediaPath: () => undefined,
    resolveChatId: () => null,
    mediaFolderId: null,
    startUpload: () => {
        throw new Error('startUpload called outside MediaResolverProvider');
    },
});

export function useMediaResolver() {
    return useContext(MediaResolverContext);
}

export function MediaResolverProvider({
    ownerId,
    mountId,
    mediaFolderId,
    chatFolderId,
    children,
}: {
    ownerId: string;
    mountId: string;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    children: ReactNode;
}) {
    const media = useFolderLookup(ownerId, mountId, mediaFolderId);
    const chat = useFolderLookup(ownerId, mountId, chatFolderId);
    // mutateAsync is referentially stable; depending on the whole mutation object would
    // rebuild startUpload (and thus the context value) on every render.
    const { mutateAsync: uploadMutateAsync } = useUploadFile(ownerId, mountId);
    // Pending uploads live in a ref, not state: consumers only need the latest URL
    // when they re-render for their own reasons (mediaName changes in Yjs). Keeping
    // the context value stable avoids re-rendering every image renderer on each upload.
    const pendingRef = useRef(new Map<string, string>());

    useEffect(() => {
        const pending = pendingRef.current;
        return () => {
            for (const blobUrl of pending.values()) {
                URL.revokeObjectURL(blobUrl);
            }
        };
    }, []);

    const startUpload = useCallback(
        (file: File) => {
            if (!mediaFolderId) {
                return { pendingName: '', promise: Promise.resolve(null) };
            }
            const pendingName = `${PENDING_PREFIX}${crypto.randomUUID()}`;
            const blobUrl = URL.createObjectURL(file);
            pendingRef.current.set(pendingName, blobUrl);

            const settle = () => {
                URL.revokeObjectURL(blobUrl);
                pendingRef.current.delete(pendingName);
            };

            const promise = uploadMutateAsync({ parentId: mediaFolderId, file })
                .then(async (result) => {
                    // Preload so the renderer's <img src=serverUrl> swap is instant.
                    // Defer settle to a macrotask so the caller's mediaName rewrite
                    // renders before the blob URL gets revoked.
                    const probe = new Image();
                    probe.src = getDrivePreviewUrl(ownerId, mountId, result.id, result.updatedAt);
                    await probe.decode().catch(() => {});
                    setTimeout(settle, 0);
                    return result;
                })
                .catch(() => {
                    settle();
                    return null;
                });

            return { pendingName, promise };
        },
        [mediaFolderId, ownerId, mountId, uploadMutateAsync],
    );

    const resolveMediaUrl = useCallback(
        (name: string): string | null => {
            if (name.startsWith(PENDING_PREFIX)) {
                return pendingRef.current.get(name) ?? null;
            }
            const file = media.findByName(name);
            return file ? getDrivePreviewUrl(ownerId, mountId, file.id, file.updatedAt) : null;
        },
        [media, ownerId, mountId],
    );

    const value = useMemo<MediaResolverValue>(
        () => ({
            resolveMediaUrl,
            resolveMediaUrlByPath,
            resolveMediaPath: (name: string) => media.findByName(name),
            resolveChatId: (name: string) => chat.findByName(name)?.id ?? null,
            mediaFolderId,
            startUpload,
        }),
        [resolveMediaUrl, media, chat, mediaFolderId, startUpload],
    );

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
