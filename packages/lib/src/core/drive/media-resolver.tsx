import {createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState} from 'react';
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
    const {data: mediaContents = [], refetch: refetchMedia} = useFolderContent(ownerId, mountId, mediaFolderId || '');
    const {data: chatContents = []} = useFolderContent(ownerId, mountId, chatFolderId || '');
    const attemptedNames = useRef(new Set<string>());
    const [needsRefetch, setNeedsRefetch] = useState(false);

    // Clear resolved names when contents update
    useEffect(() => {
        for (const name of attemptedNames.current) {
            if (mediaContents.some(f => f.name === name)) {
                attemptedNames.current.delete(name);
            }
        }
    }, [mediaContents]);

    // Refetch media folder when an unresolved name is detected
    useEffect(() => {
        if (needsRefetch) {
            setNeedsRefetch(false);
            refetchMedia();
        }
    }, [needsRefetch, refetchMedia]);

    const value = useMemo<MediaResolverValue>(() => ({
        resolveMediaUrl: (name: string) => {
            const file = mediaContents.find(f => f.name === name);
            if (file) return getDrivePreviewUrl(ownerId, mountId, file.id);
            // File not in cache — a collaborator may have uploaded it; schedule refetch once per name
            if (name && mediaFolderId && !attemptedNames.current.has(name)) {
                attemptedNames.current.add(name);
                setNeedsRefetch(true);
            }
            return null;
        },
        resolveMediaPath: (name: string) => mediaContents.find(f => f.name === name),
        resolveChatId: (name: string) => chatContents.find(f => f.name === name)?.id ?? null,
        mediaFolderId,
    }), [mediaContents, chatContents, ownerId, mountId, mediaFolderId]);

    return <MediaResolverContext value={value}>{children}</MediaResolverContext>;
}
