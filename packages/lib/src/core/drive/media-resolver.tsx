import {createContext, type ReactNode, useContext, useMemo} from 'react';
import {useFolderContent} from './hooks/use-drive';
import {getDrivePreviewUrl} from '../api';
import type {DrivePath} from '../../types/drive';

type MediaResolverValue = {
    resolveMediaUrl: (name: string) => string | null;
    resolveMediaPath: (name: string) => DrivePath | undefined;
    resolveChatId: (name: string) => string | null;
    mediaFolderId: string | null;
}

const MediaResolverContext = createContext<MediaResolverValue>({
    resolveMediaUrl: () => null,
    resolveMediaPath: () => undefined,
    resolveChatId: () => null,
    mediaFolderId: null,
});

export function useMediaResolver() {
    return useContext(MediaResolverContext);
}

export function MediaResolverProvider({ownerId, mountId, mediaFolderId, chatFolderId, children}: {
    ownerId: string;
    mountId: string;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    children: ReactNode;
}) {
    const {data: mediaContents = []} = useFolderContent(ownerId, mountId, mediaFolderId || '');
    const {data: chatContents = []} = useFolderContent(ownerId, mountId, chatFolderId || '');

    const value = useMemo<MediaResolverValue>(() => ({
        resolveMediaUrl: (name: string) => {
            const file = mediaContents.find(f => f.name === name);
            if (!file) return null;
            return getDrivePreviewUrl(ownerId, mountId, file.id);
        },
        resolveMediaPath: (name: string) => mediaContents.find(f => f.name === name),
        resolveChatId: (name: string) => chatContents.find(f => f.name === name)?.id ?? null,
        mediaFolderId,
    }), [mediaContents, chatContents, ownerId, mountId, mediaFolderId]);

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
