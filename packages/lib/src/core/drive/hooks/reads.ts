import { useQueries, useQuery } from '@tanstack/react-query';
import { driveApi, emlPreviewRoute, icsPreviewRoute, vcardPreviewRoute } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppError, retryWhenTransformBusy } from '../../api-error';
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
        staleTime: STALE_TIME.ONE_MINUTE,
        enabled: !!ownerId,
    });
}

// GET ROOT FOLDER
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

// GET FOLDER CONTENTS
export function folderContentQueryConfig(ownerId: string, mountId: string, pathId: string) {
    return {
        queryKey: driveKeys.folder(ownerId, mountId, pathId),
        queryFn: async (): Promise<DrivePath[]> => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
            if (response.error) {
                throw new AppError(response);
            }
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

// FOLDER LOOKUP — wraps useFolderContent with refetch-on-miss for name-based lookups.
// When a collaborator uploads a file, Yjs propagates the name before our cache updates.
// findByName() triggers a single refetch per unknown name, preventing infinite loops.
export function useFolderLookup(ownerId: string, mountId: string, folderId: string | null) {
    const { data = [], refetch } = useFolderContent(ownerId, mountId, folderId || '');
    const attemptedRef = useRef(new Set<string>());
    const refetchQueuedRef = useRef(false);

    useEffect(() => {
        for (const name of attemptedRef.current) {
            if (data.some((f) => f.name === name)) {
                attemptedRef.current.delete(name);
            }
        }
    }, [data]);

    const findByName = useCallback(
        (name: string): DrivePath | undefined => {
            const item = data.find((f) => f.name === name);
            if (!item && name && folderId && !attemptedRef.current.has(name)) {
                attemptedRef.current.add(name);
                // Consumers resolve names during render (image renderers, chat embeds), so the
                // refetch kick must not setState here — that's an update to this hook's owner
                // while a DIFFERENT component renders (React error). Defer to a microtask,
                // collapsing a burst of misses (multi-file drop) into one refetch.
                if (!refetchQueuedRef.current) {
                    refetchQueuedRef.current = true;
                    queueMicrotask(() => {
                        refetchQueuedRef.current = false;
                        refetch();
                    });
                }
            }
            return item;
        },
        [data, folderId, refetch],
    );

    // Stable return object — MediaResolver's context value memoizes on it, and a fresh
    // literal per render would re-render every context subscriber (e.g. all board cards).
    return useMemo(() => ({ contents: data, findByName }), [data, findByName]);
}

// GET MIME CONTENTS (aggregates over all mounts of one owner)
export function useMimeContent(ownerId: string, mimeType: string) {
    return useQuery({
        queryKey: driveKeys.mime(ownerId, mimeType),
        queryFn: async (): Promise<DrivePath[]> => {
            if (!mimeType) return [];
            const response = await driveApi({ ownerId }).mime({ mimeType }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!mimeType && !!ownerId,
        retry: 1,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

// GET AGGREGATE MIME CONTENTS — personal + every team the signed-in user belongs to, merged and
// deduped server-side (GET /drive/:ownerId/mime/:mimeType?teams=1). Always scoped to the current
// user, so it reads useAuth itself rather than taking an ownerId.
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

// GET MIME CONTENTS scoped to a single mount
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

// GET PATH INFO
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
            staleTime: STALE_TIME.FIVE_MINUTES,
        })),
    });
}

// GET BREADCRUMB PATH
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
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });
}

// GET VCARD PREVIEW — the contact cards a .vcf holds, parsed server-side (PREVIEWS.md). The quick look
// and the drive hero read the same query. `updatedAt` is in the key, so a new version is a new entry and
// the cards never go stale; the query stays off a file the import ceiling would refuse anyway.
export function useVCardPreview(ownerId: string, mountId: string, pathId: string, updatedAt: Date, size: number) {
    return useQuery({
        queryKey: driveKeys.vcardPreview(ownerId, mountId, pathId, updatedAt),
        queryFn: async () => {
            // vcardPreviewRoute, not driveApi: a card's birthday is a date-only string, and the default
            // treaty's reviver would hand the renderer a Date (api.ts).
            const response = await vcardPreviewRoute(ownerId, mountId, pathId).get({
                query: { updatedAt: updatedAt.toISOString() },
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId && size <= VCARD_MAX_BYTES,
        staleTime: Infinity,
        retry: retryWhenTransformBusy,
    });
}

// GET EML PREVIEW — the message a .eml holds, parsed and sanitized server-side (PREVIEWS.md). Keyed by
// `updatedAt` like the cards above, so a new version is a new entry; the route itself answers
// `private, no-cache`, so a browser that already holds a body revalidates it.
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
        staleTime: Infinity,
        retry: retryWhenTransformBusy,
    });
}

// GET ICS PREVIEW — the events an .ics holds, parsed server-side (PREVIEWS.md). Keyed by `updatedAt`
// like the two above, so a new version is a new entry.
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
        staleTime: Infinity,
        retry: retryWhenTransformBusy,
    });
}
