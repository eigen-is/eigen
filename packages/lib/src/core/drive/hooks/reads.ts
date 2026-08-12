import { useQueries, useQuery } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppError } from '../../api-error';
import { driveKeys } from './keys';

// GET MOUNTS
export function useMounts(ownerId: string) {
    return useQuery({
        queryKey: driveKeys.mounts(ownerId),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).mounts.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: 60_000,
        enabled: !!ownerId,
    });
}

// GET ROOT FOLDER
export function useRootFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    return useQuery<DrivePath | null>({
        queryKey: driveKeys.root(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).root.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: 60_000,
        enabled: !!ownerId && !!mountId,
    });
}

// GET FOLDER CONTENTS
export function useFolderContent(ownerId: string, mountId: string, pathId: string) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.folder(ownerId, mountId, pathId),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
            if (response.error) {
                throw new AppError(response);
            }
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        retry: 1,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// FOLDER LOOKUP — wraps useFolderContent with refetch-on-miss for name-based lookups.
// When a collaborator uploads a file, Yjs propagates the name before our cache updates.
// findByName() triggers a single refetch per unknown name, preventing infinite loops.
export function useFolderLookup(ownerId: string, mountId: string, folderId: string | null) {
    const { data = [], refetch } = useFolderContent(ownerId, mountId, folderId || '');
    const attemptedRef = useRef(new Set<string>());
    const [refetchToken, setRefetchToken] = useState(0);

    useEffect(() => {
        for (const name of attemptedRef.current) {
            if (data.some((f) => f.name === name)) {
                attemptedRef.current.delete(name);
            }
        }
    }, [data]);

    useEffect(() => {
        if (refetchToken > 0) refetch();
    }, [refetchToken, refetch]);

    const findByName = useCallback(
        (name: string): DrivePath | undefined => {
            const item = data.find((f) => f.name === name);
            if (!item && name && folderId && !attemptedRef.current.has(name)) {
                attemptedRef.current.add(name);
                setRefetchToken((c) => c + 1);
            }
            return item;
        },
        [data, folderId],
    );

    // Stable return object — MediaResolver's context value memoizes on it, and a fresh
    // literal per render would re-render every context subscriber (e.g. all board cards).
    return useMemo(() => ({ contents: data, findByName }), [data, findByName]);
}

// GET MIME CONTENTS (aggregates over all mounts of one owner)
export function mimeContentQueryConfig(ownerId: string, mimeType: string, staleTime: number = 1000 * 60 * 5) {
    return {
        queryKey: driveKeys.mime(ownerId, mimeType),
        queryFn: async (): Promise<DrivePath[]> => {
            if (!mimeType) return [];
            const response = await driveApi({ ownerId }).mime({ mimeType }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!mimeType && !!ownerId,
        retry: 1,
        staleTime,
    };
}

export function useMimeContent(ownerId: string, mimeType: string, staleTime?: number) {
    return useQuery<DrivePath[]>(mimeContentQueryConfig(ownerId, mimeType, staleTime));
}

// GET AGGREGATE MIME CONTENTS — personal + every team the signed-in user belongs to, merged and
// deduped server-side (GET /drive/:ownerId/mime/:mimeType?teams=1). Always scoped to the current
// user, so it reads useAuth itself rather than taking an ownerId.
export function useAggregateMimeContent(mimeType: string, staleTime: number = 1000 * 60 * 5, enabled: boolean = true) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.mimeAll(mimeType),
        queryFn: async () => {
            if (!mimeType || !ownerId) return [];
            const response = await driveApi({ ownerId })
                .mime({ mimeType })
                .get({ query: { teams: '1' } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!mimeType && !!ownerId,
        retry: 1,
        staleTime,
    });
}

// GET MIME CONTENTS scoped to a single mount
export function useMountMimeContent(ownerId: string, mountId: string, mimeType: string) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.mountMime(ownerId, mountId, mimeType),
        queryFn: async () => {
            if (!mimeType) return [];
            const response = await driveApi({ ownerId })({ mountId }).mime({ mimeType }).get();
            if (response.error) {
                throw new AppError(response);
            }
            return response.data;
        },
        enabled: !!mimeType && !!ownerId && !!mountId,
        retry: 1,
        staleTime: 1000 * 60 * 5,
    });
}

// GET PATH INFO
export function usePathInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery<DrivePath | null>({
        queryKey: driveKeys.path(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// Batch variant — shares cache with usePathInfo so a path fetched here hits the
// same `driveKeys.path` entry. Returns the underlying useQuery results in order.
export function usePathInfos(refs: { ownerId: string; mountId: string; pathId: string }[]) {
    return useQueries({
        queries: refs.map((r) => ({
            queryKey: driveKeys.path(r.ownerId, r.mountId, r.pathId),
            queryFn: async (): Promise<DrivePath | null> => {
                const response = await driveApi({ ownerId: r.ownerId })({ mountId: r.mountId })
                    .path({ pathId: r.pathId })
                    .get();
                if (response.error) throw new AppError(response);
                return response.data;
            },
            enabled: !!r.pathId && !!r.ownerId && !!r.mountId,
            staleTime: 1000 * 60 * 5,
        })),
    });
}

// GET BREADCRUMB PATH
export function useBreadcrumb(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.breadcrumb(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).breadcrumb.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// TEXT PREVIEW
export function useTextPreview(
    ownerId: string,
    mountId: string,
    pathId: string,
    updatedAt: Date | undefined,
    enabled: boolean,
) {
    return useQuery({
        queryKey: driveKeys.textPreview(ownerId, mountId, pathId, updatedAt),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId })
                .file({ pathId })
                ['text-preview'].get({ query: { updatedAt: updatedAt?.toISOString() } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: enabled && !!pathId && !!ownerId && !!mountId,
        // Short window so a stale-while-revalidate preview (the previous version, served while
        // the current one regenerates server-side) self-heals: after 30s the query is stale, so
        // the next refetch trigger (window focus or remount) fetches the fresh copy.
        staleTime: 1000 * 30,
    });
}
