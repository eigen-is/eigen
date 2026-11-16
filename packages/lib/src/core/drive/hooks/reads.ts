// The Drive read hooks: one query each for a mount list, a root, a folder, a type list, a path, a breadcrumb
// and the server-side previews of some file kinds, keyed by driveKeys so write hooks and drive events refresh
// them. Views across the apps, such as Drive's folder view and a document app's index, read through them.

import type { UseQueryResult } from '@tanstack/react-query';
import { useQueries, useQuery } from '@tanstack/react-query';
import { driveApi, emlPreviewRoute, icsPreviewRoute, vcardPreviewRoute } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppError, retryWhenTransformBusy } from '../../api-error';
import { driveKeys } from './keys';

export function useMounts(ownerId: string) {
    return useQuery({
        queryKey: driveKeys.mounts(ownerId),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).mounts.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
        enabled: !!ownerId,
    });
}

export function useRootFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    return useQuery({
        queryKey: driveKeys.root(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).root.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
        enabled: !!ownerId && !!mountId,
    });
}

// The location with an empty folder id filled in as the mount's root, which stays empty until the root has loaded.
export function useResolvedDriveLocation(value: DriveLocationValue): DriveLocationValue {
    const { data: rootFolder } = useRootFolder(value.ownerId, value.mountId);
    return value.folderId ? value : { ...value, folderId: rootFolder?.id ?? '' };
}

export function folderContentQueryConfig(ownerId: string, mountId: string, pathId: string) {
    return {
        queryKey: driveKeys.folder(ownerId, mountId, pathId),
        queryFn: async (): Promise<DrivePath[]> => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        retry: 1,
        staleTime: STALE_TIME.FIVE_MINUTES,
    };
}

export function useFolderContent(ownerId: string, mountId: string, pathId: string) {
    return useQuery(folderContentQueryConfig(ownerId, mountId, pathId));
}

// A collaborator's upload reaches a document's Yjs state before this cache, so a name that misses refetches
// the folder once, and isMissing turns true when that refetch settled without it.
export function useFolderLookup(
    ownerId: string,
    mountId: string,
    folderId: string | null,
): {
    contents: DrivePath[];
    findByName: (name: string) => DrivePath | undefined;
    isMissing: (name: string) => boolean;
} {
    const { data = [], refetch } = useFolderContent(ownerId, mountId, folderId || '');
    const attemptedRef = useRef(new Set<string>());
    const refetchQueuedRef = useRef(false);
    const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());

    useEffect(() => {
        for (const name of attemptedRef.current) {
            if (data.some((f) => f.name === name)) {
                attemptedRef.current.delete(name);
            }
        }
        setMissing((prev) => {
            const next = new Set([...prev].filter((name) => !data.some((f) => f.name === name)));
            return next.size === prev.size ? prev : next;
        });
    }, [data]);

    const findByName = useCallback(
        (name: string): DrivePath | undefined => {
            const item = data.find((f) => f.name === name);
            if (!item && name && folderId && !attemptedRef.current.has(name)) {
                attemptedRef.current.add(name);
                // Names resolve while other components render, where a state update here is a React error, so
                // the refetch waits for a microtask, which also folds a burst of misses into one.
                if (!refetchQueuedRef.current) {
                    refetchQueuedRef.current = true;
                    queueMicrotask(() => {
                        refetchQueuedRef.current = false;
                        // Only names asked before this refetch started can be judged by its result.
                        const asked = [...attemptedRef.current];
                        refetch().then((result) => {
                            if (!result.isSuccess) return;
                            const absent = asked.filter((n) => !result.data.some((f) => f.name === n));
                            if (absent.length > 0) setMissing((prev) => new Set([...prev, ...absent]));
                        });
                    });
                }
            }
            return item;
        },
        [data, folderId, refetch],
    );

    const isMissing = useCallback((name: string): boolean => missing.has(name), [missing]);

    // A context value memoizes on this object, and a fresh one per render would re-render every subscriber.
    return useMemo(() => ({ contents: data, findByName, isMissing }), [data, findByName, isMissing]);
}

// The signed-in user's files of one type over their own drive and every team's, merged on the server, and
// what others shared with them.
export function useAggregateMimeContent(
    mimeType: string,
    staleTime: number = STALE_TIME.FIVE_MINUTES,
    enabled: boolean = true,
) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    return useQuery({
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

export function mountMimeContentQueryConfig(ownerId: string, mountId: string, mimeType: string) {
    return {
        queryKey: driveKeys.mountMime(ownerId, mountId, mimeType),
        queryFn: async (): Promise<DrivePath[]> => {
            if (!mimeType) return [];
            const response = await driveApi({ ownerId })({ mountId }).mime({ mimeType }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!mimeType && !!ownerId && !!mountId,
        retry: 1,
        staleTime: STALE_TIME.FIVE_MINUTES,
    };
}

export function useMountMimeContent(ownerId: string, mountId: string, mimeType: string) {
    return useQuery(mountMimeContentQueryConfig(ownerId, mountId, mimeType));
}

export function usePathInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.path(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

// Shares usePathInfo's cache entries, so a path fetched by either is fetched once.
export function usePathInfos(
    refs: { ownerId: string; mountId: string; pathId: string }[],
): UseQueryResult<DrivePath | null>[] {
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
            staleTime: STALE_TIME.FIVE_MINUTES,
        })),
    });
}

export function useBreadcrumb(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.breadcrumb(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).breadcrumb.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

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
        // The server may answer with the previous version's preview while it builds the new one, so a short
        // window lets the next focus or remount fetch the fresh copy.
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });
}

// The contact cards a .vcf holds, parsed on the server. The short window is useTextPreview's, and the query
// stays off a file the import ceiling would refuse anyway.
export function useVCardPreview(ownerId: string, mountId: string, pathId: string, updatedAt: Date, size: number) {
    return useQuery({
        queryKey: driveKeys.vcardPreview(ownerId, mountId, pathId, updatedAt),
        queryFn: async () => {
            // A card's birthday is a date-only string, which driveApi's reviver would turn into a Date.
            const response = await vcardPreviewRoute(ownerId, mountId, pathId).get({
                query: { updatedAt: updatedAt.toISOString() },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId && size <= VCARD_MAX_BYTES,
        staleTime: STALE_TIME.THIRTY_SECONDS,
        retry: retryWhenTransformBusy,
    });
}

// The message a .eml holds, parsed and sanitized on the server, keyed by its version like the cards above.
export function useEmlPreview(ownerId: string, mountId: string, pathId: string, updatedAt: Date, size: number) {
    return useQuery({
        queryKey: driveKeys.emlPreview(ownerId, mountId, pathId, updatedAt),
        queryFn: async () => {
            const response = await emlPreviewRoute(ownerId, mountId, pathId).get({
                query: { updatedAt: updatedAt.toISOString() },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId && size <= EML_MAX_BYTES,
        staleTime: STALE_TIME.THIRTY_SECONDS,
        retry: retryWhenTransformBusy,
    });
}

// The events an .ics holds, parsed on the server, keyed by its version like the two above.
export function useIcsPreview(ownerId: string, mountId: string, pathId: string, updatedAt: Date, size: number) {
    return useQuery({
        queryKey: driveKeys.icsPreview(ownerId, mountId, pathId, updatedAt),
        queryFn: async () => {
            const response = await icsPreviewRoute(ownerId, mountId, pathId).get({
                query: { updatedAt: updatedAt.toISOString() },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId && size <= ICS_MAX_BYTES,
        staleTime: STALE_TIME.THIRTY_SECONDS,
        retry: retryWhenTransformBusy,
    });
}
