import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DrivePath } from '../../types/drive';
import { getDrivePreviewUrl } from '../api';
import { useFolderLookup, useUploadFile } from './hooks/use-drive';

const PENDING_PREFIX = 'pending:';

export function isPendingMediaName(name: string): boolean {
    return name.startsWith(PENDING_PREFIX);
}

type MediaResolverValue = {
    resolveMediaUrl: (name: string) => string | null;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveChatId: (name: string) => string | null;
    mediaFolderId: string | null;
    startUpload: (file: File) => { pendingName: string; promise: Promise<DrivePath | null> };
};

const MediaResolverContext = createContext<MediaResolverValue>({
    resolveMediaUrl: () => null,
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
    const uploadFile = useUploadFile(ownerId, mountId);
    const [pending, setPending] = useState<Map<string, string>>(() => new Map());
    const pendingRef = useRef(pending);
    pendingRef.current = pending;

    // Unmount cleanup can't read latest state via closure — capture via ref instead.
    useEffect(() => {
        return () => {
            for (const blobUrl of pendingRef.current.values()) {
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
            setPending((prev) => new Map(prev).set(pendingName, blobUrl));

            const settle = () => {
                URL.revokeObjectURL(blobUrl);
                setPending((prev) => {
                    if (!prev.has(pendingName)) return prev;
                    const next = new Map(prev);
                    next.delete(pendingName);
                    return next;
                });
            };

            const promise = uploadFile
                .mutateAsync({ parentId: mediaFolderId, file })
                .then(async (result) => {
                    // Preload the server URL so the caller's mediaName-rewrite renders
                    // with an already-decoded <img>, no blank gap. Defer settle to a
                    // macrotask so the rewrite render runs before the blob URL is revoked.
                    const url = getDrivePreviewUrl(ownerId, mountId, result.id);
                    await new Promise<void>((resolve) => {
                        const probe = new Image();
                        probe.onload = () => resolve();
                        probe.onerror = () => resolve();
                        probe.src = url;
                    });
                    setTimeout(settle, 0);
                    return result;
                })
                .catch(() => {
                    settle();
                    return null;
                });

            return { pendingName, promise };
        },
        [mediaFolderId, uploadFile],
    );

    const value = useMemo<MediaResolverValue>(
        () => ({
            resolveMediaUrl: (name: string) => {
                if (name.startsWith(PENDING_PREFIX)) {
                    return pending.get(name) ?? null;
                }
                const file = media.findByName(name);
                return file ? getDrivePreviewUrl(ownerId, mountId, file.id) : null;
            },
            resolveMediaPath: (name: string) => media.findByName(name),
            resolveChatId: (name: string) => chat.findByName(name)?.id ?? null,
            mediaFolderId,
            startUpload,
        }),
        [media, chat, ownerId, mountId, mediaFolderId, pending, startUpload],
    );

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
