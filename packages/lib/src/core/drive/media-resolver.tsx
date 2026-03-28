import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { DrivePath } from '../../types/drive';
import { getDrivePreviewUrl } from '../api';
import { useFolderLookup } from './hooks/use-drive';

type MediaResolverValue = {
    resolveMediaUrl: (name: string) => string | null;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveChatId: (name: string) => string | null;
    mediaFolderId: string | null;
};

const MediaResolverContext = createContext<MediaResolverValue>({
    resolveMediaUrl: () => null,
    resolveMediaPath: () => undefined,
    resolveChatId: () => null,
    mediaFolderId: null,
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

    const value = useMemo<MediaResolverValue>(
        () => ({
            resolveMediaUrl: (name: string) => {
                const file = media.findByName(name);
                return file ? getDrivePreviewUrl(ownerId, mountId, file.id) : null;
            },
            resolveMediaPath: (name: string) => media.findByName(name),
            resolveChatId: (name: string) => chat.findByName(name)?.id ?? null,
            mediaFolderId,
        }),
        [media, chat, ownerId, mountId, mediaFolderId],
    );

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
