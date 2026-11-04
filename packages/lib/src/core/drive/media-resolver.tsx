// Turns the media names a document stores into URLs. A document keeps its pictures and attachments in a media folder
// of its own and stores only their names, so a renderer such as a canvas image or a chat embed asks this provider for
// the URL. It also shows a picture this tab is still uploading from a local blob URL until the upload lands, and finds
// a comment's thread by name in the document's chat folder.

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { DrivePath } from '../../types/drive';
import { getDrivePreviewUrl, getDriveThumbnailUrl } from '../api';
import { useFolderLookup } from './hooks/reads';
import { useUploadFile } from './hooks/writes';

// The start of a media name that exists only in this tab until its upload lands. Every host that shows an image
// before its upload finishes, such as a paste onto the canvas, writes one.
export const PENDING_PREFIX = 'pending:';

export function isPendingMediaName(name: string): boolean {
    return name.startsWith(PENDING_PREFIX);
}

// The URL of a file whose DrivePath a copy or an upload just returned. A lookup by name reads the media folder's
// listing, which doesn't hold that file yet, so it would find nothing. Render still resolves by name, because a name
// is all a document stores, and the listing catches up.
function resolveMediaUrlByPath(path: DrivePath): string {
    return getDrivePreviewUrl(path.ownerId, path.mountId, path.id, path.updatedAt);
}

type MediaResolverValue = {
    resolveMediaUrl: (name: string) => string | null;
    // The still thumbnail, for a small copy of a picture such as a tile in the Slides rail. A picture without one yet
    // gets its preview.
    resolveMediaThumbnailUrl: (name: string) => string | null;
    resolveMediaUrlByPath: (path: DrivePath) => string;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    // True once a name is known not to resolve, so a renderer swaps its loader for a missing look.
    isMediaMissing: (name: string) => boolean;
    resolveChatId: (name: string) => string | null;
    // True once a comment thread's name is known not to resolve, as isMediaMissing is for a picture.
    isChatMissing: (name: string) => boolean;
    mediaFolderId: string | null;
    startUpload: (file: File) => { pendingName: string; promise: Promise<DrivePath | null> };
};

const MediaResolverContext = createContext<MediaResolverValue>({
    resolveMediaUrl: () => null,
    resolveMediaThumbnailUrl: () => null,
    resolveMediaUrlByPath,
    resolveMediaPath: () => undefined,
    isMediaMissing: () => false,
    resolveChatId: () => null,
    isChatMissing: () => false,
    mediaFolderId: null,
    startUpload: () => {
        throw new Error('startUpload called outside MediaResolverProvider');
    },
});

export function useMediaResolver(): MediaResolverValue {
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
    // mutateAsync keeps its identity across renders. The whole mutation object doesn't, and depending on it would
    // rebuild startUpload, and with it the context value, on every render.
    const { mutateAsync: uploadMutateAsync } = useUploadFile(ownerId, mountId);
    // Pending uploads live in a ref, not in state. A renderer needs the latest URL only when it renders for its own
    // reason, such as its media name changing in Yjs. So the context value stays the same, and an upload doesn't
    // render every image again.
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
                    // The server's copy loads before the swap, so the image doesn't flash. The blob URL is revoked a
                    // task later, after the caller's new media name has rendered.
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
            if (isPendingMediaName(name)) return pendingRef.current.get(name) ?? null;
            const file = media.findByName(name);
            return file ? getDrivePreviewUrl(ownerId, mountId, file.id, file.updatedAt) : null;
        },
        [media, ownerId, mountId],
    );

    const resolveMediaThumbnailUrl = useCallback(
        (name: string): string | null => {
            const file = isPendingMediaName(name) ? undefined : media.findByName(name);
            return file?.thumbnail
                ? getDriveThumbnailUrl(ownerId, mountId, file.thumbnail, file.updatedAt)
                : resolveMediaUrl(name);
        },
        [media, ownerId, mountId, resolveMediaUrl],
    );

    const value = useMemo<MediaResolverValue>(
        () => ({
            resolveMediaUrl,
            resolveMediaThumbnailUrl,
            resolveMediaUrlByPath,
            resolveMediaPath: (name: string) => media.findByName(name),
            // The editor routes mount this only after the document's listing loaded, so a null
            // folder id means the document has no such folder, not that it is still unknown.
            isMediaMissing: (name: string) => !isPendingMediaName(name) && (!mediaFolderId || media.isMissing(name)),
            resolveChatId: (name: string) => chat.findByName(name)?.id ?? null,
            isChatMissing: (name: string) => !chatFolderId || chat.isMissing(name),
            mediaFolderId,
            startUpload,
        }),
        [resolveMediaUrl, resolveMediaThumbnailUrl, media, chat, mediaFolderId, chatFolderId, startUpload],
    );

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
