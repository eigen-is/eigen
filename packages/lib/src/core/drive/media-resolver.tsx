import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DrivePath } from '../../types/drive';
import { getDrivePreviewUrl } from '../api';
import { useFolderLookup, useUploadFile } from './hooks/use-drive';

const PENDING_PREFIX = 'pending:';

export function isPendingMediaName(name: string): boolean {
    return name.startsWith(PENDING_PREFIX);
}

type PendingUpload = {
    pendingName: string;
    file: File;
    blobUrl: string;
};

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
    startUpload: () => ({ pendingName: '', promise: Promise.resolve(null) }),
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
    const [pending, setPending] = useState<Map<string, PendingUpload>>(() => new Map());
    const pendingRef = useRef(pending);
    pendingRef.current = pending;

    // Unmount cleanup can't read latest state via closure — capture via ref instead.
    useEffect(() => {
        return () => {
            for (const entry of pendingRef.current.values()) {
                URL.revokeObjectURL(entry.blobUrl);
            }
        };
    }, []);

    const startUpload = useCallback(
        (file: File) => {
            const pendingName = `${PENDING_PREFIX}${crypto.randomUUID()}`;
            const blobUrl = URL.createObjectURL(file);
            setPending((prev) => {
                const next = new Map(prev);
                next.set(pendingName, { pendingName, file, blobUrl });
                return next;
            });

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
                .mutateAsync({ parentId: mediaFolderId ?? '', file })
                .then((result) => {
                    settle();
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
                    return pending.get(name)?.blobUrl ?? null;
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
