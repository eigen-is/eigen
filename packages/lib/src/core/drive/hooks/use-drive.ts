import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi, getDriveAppUrl, getDriveFileUploadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    type DriveACL,
    type DrivePath,
    type DriveVisibility,
    type EigenDocType,
} from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { collabKeys } from '../../collab/hooks/use-collab';
import { invalidateHomeSize } from '../../home';

export { DEFAULT_MOUNT_ID };

// Define query keys for reuse
export const driveKeys = {
    all: ['drive'] as const,
    owner: (ownerId: string) => [...driveKeys.all, ownerId] as const,
    mounts: (ownerId: string) => [...driveKeys.owner(ownerId), 'mounts'] as const,
    root: (ownerId: string, mountId: string) => [...driveKeys.owner(ownerId), 'root', mountId] as const,
    folders: (ownerId: string) => [...driveKeys.owner(ownerId), 'folder'] as const,
    folder: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.folders(ownerId), mountId, pathId] as const,
    mimeTypes: (ownerId: string) => [...driveKeys.owner(ownerId), 'mime'] as const,
    mime: (ownerId: string, mimeType: string) => [...driveKeys.mimeTypes(ownerId), mimeType] as const,
    // Aggregate (personal + every team the caller belongs to) mime listing. Deliberately owner-less
    // (always "the current user's everything"); the mimeAllTypes prefix enables form-agnostic invalidation.
    mimeAllTypes: () => [...driveKeys.all, 'mimeAll'] as const,
    mimeAll: (mimeType: string) => [...driveKeys.mimeAllTypes(), mimeType] as const,
    mountMime: (ownerId: string, mountId: string, mimeType: string) =>
        [...driveKeys.mimeTypes(ownerId), mountId, mimeType] as const,
    paths: (ownerId: string) => [...driveKeys.owner(ownerId), 'path'] as const,
    path: (ownerId: string, mountId: string, pathId: string) => [...driveKeys.paths(ownerId), mountId, pathId] as const,
    breadcrumb: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.path(ownerId, mountId, pathId), 'breadcrumb'] as const,
    permissions: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'permissions', mountId, pathId] as const,
    shared: (ownerId: string, to: 'by-me' | 'with-me') => [...driveKeys.owner(ownerId), 'shared', to] as const,
    textPreviews: (ownerId: string) => [...driveKeys.owner(ownerId), 'text-preview'] as const,
    textPreview: (ownerId: string, mountId: string, pathId: string, updatedAt?: Date) =>
        [...driveKeys.textPreviews(ownerId), mountId, pathId, updatedAt?.getTime()] as const,
    effectiveMembers: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'effective-members', mountId, pathId] as const,
    trash: (ownerId: string) => [...driveKeys.owner(ownerId), 'trash'] as const,
    trashList: (ownerId: string, mountId: string) => [...driveKeys.trash(ownerId), mountId] as const,
    history: (ownerId: string) => [...driveKeys.owner(ownerId), 'history'] as const,
    fileHistory: (ownerId: string, mountId: string, pathId: string, limit: number) =>
        [...driveKeys.history(ownerId), mountId, pathId, limit] as const,
    watches: (ownerId: string) => [...driveKeys.owner(ownerId), 'watches'] as const,
    // Aggregate watches across the caller's own home, teams, and shared owners. Owner-less like
    // mimeAll: it always means "everything the current user watches".
    watchesAll: () => [...driveKeys.all, 'watchesAll'] as const,
    pathWatched: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.watches(ownerId), mountId, pathId] as const,
};

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

// CREATE FOLDER
export function useCreateFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, folderName }: { parentId: string; folderName: string }) => {
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId: parentId }).post({ folderName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId),
        onError: onMutationError,
    });
}

export function useCreateFolderItem() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            ownerId,
            mountId,
            parentId,
            folderName,
        }: {
            ownerId: string;
            mountId: string;
            parentId: string;
            folderName: string;
        }) => {
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId: parentId }).post({ folderName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_, variables) =>
            invalidateItemCreated(queryClient, variables.ownerId, variables.mountId, variables.parentId),
        onError: onMutationError,
    });
}

// UPLOAD FILE(S)
export function useUploadFile(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, file }: { parentId: string; file: File }): Promise<DrivePath> => {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(getDriveFileUploadUrl(ownerId, mountId, parentId), {
                method: 'POST',
                body: formData,
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
            const data = (await res.json()) as DrivePath[];
            // Raw fetch bypasses Eden's Date reviver, so the JSON dates arrive as strings.
            // Revive them so the returned value honours its DrivePath type (callers like
            // the media-resolver probe call updatedAt.getTime()).
            const path = data[0];
            return {
                ...path,
                createdAt: new Date(path.createdAt),
                updatedAt: new Date(path.updatedAt),
                trashedAt: path.trashedAt ? new Date(path.trashedAt) : null,
            };
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId),
        onError: onMutationError,
    });
}

// DELETE MULTIPLE PATHS — derives owner/mount from each path so mixed-owner selections
// (aggregate filter views list other owners' items) each hit their own home.
export function useDeletePaths() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (paths: DrivePath[]) => {
            const results = await Promise.allSettled(
                paths.map(async (path) => {
                    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                        .path({ pathId: path.id })
                        .delete();
                    if (response.error) throw new AppError(response);
                    return path;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            for (const path of succeeded) {
                invalidateItemDeleted(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            }
            const failedCount = results.filter((r) => r.status === 'rejected').length;
            if (failedCount > 0) throw new Error(`Failed to delete ${failedCount} of ${paths.length} items`);
            return succeeded;
        },
        onError: onMutationError,
    });
}

export function useMovePath(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, currentParentId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ pathId, targetParentId }: { pathId: string; targetParentId: string }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).move.put({ targetParentId });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidatePathMoved(
                queryClient,
                ownerId,
                mountId,
                variables.pathId,
                variables.targetParentId,
                currentParentId,
            ),
        onError: onMutationError,
    });
}

export function useCopyFiles(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            pathIds,
            targetOwnerId,
            targetMountId,
            targetParentId,
        }: {
            pathIds: string[];
            targetOwnerId: string;
            targetMountId: string;
            targetParentId: string;
        }) => {
            const results = [];
            for (const pathId of pathIds) {
                const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).copy.post({
                    targetOwnerId,
                    targetMountId,
                    targetParentId,
                });
                if (response.error) throw new AppError(response);
                results.push(response.data);
            }
            return results;
        },
        onSuccess: (_data, variables) => {
            invalidateItemCreated(
                queryClient,
                variables.targetOwnerId,
                variables.targetMountId,
                variables.targetParentId,
            );
            const count = variables.pathIds.length;
            toast.success(count === 1 ? 'File saved to Drive' : `${count} files saved to Drive`, {
                action: {
                    label: 'Open folder',
                    onClick: () => {
                        window.location.href = getDriveAppUrl(
                            `fs/${variables.targetOwnerId}/${variables.targetMountId}/${variables.targetParentId}`,
                        );
                    },
                },
            });
        },
        onError: onMutationError,
    });
}

export function useCopyToMediaFolder(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ paths, mediaFolderId }: { paths: DrivePath[]; mediaFolderId: string }) => {
            const results = await Promise.allSettled(
                paths.map(async (path) => {
                    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                        .path({ pathId: path.id })
                        .copy.post({
                            targetOwnerId: ownerId,
                            targetMountId: mountId,
                            targetParentId: mediaFolderId,
                        });
                    if (response.error) throw new AppError(response);
                    return response.data;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            if (succeeded.length > 0) {
                invalidateItemCreated(queryClient, ownerId, mountId, mediaFolderId);
            }
            const failedCount = results.length - succeeded.length;
            if (failedCount > 0) {
                throw new Error(
                    failedCount === results.length
                        ? 'Failed to copy files'
                        : `Failed to copy ${failedCount} of ${results.length} files`,
                );
            }
            return succeeded;
        },
        onError: onMutationError,
    });
}

export function useCopyPath() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            items,
            targetOwnerId,
            targetMountId,
            targetParentId,
        }: {
            items: DrivePath[];
            targetOwnerId: string;
            targetMountId: string;
            targetParentId: string;
        }) => {
            const results = await Promise.allSettled(
                items.map(async (item) => {
                    const response = await driveApi({ ownerId: item.ownerId })({ mountId: item.mountId })
                        .path({ pathId: item.id })
                        .copy.post({ targetOwnerId, targetMountId, targetParentId });
                    if (response.error) throw new AppError(response);
                    return response.data;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            if (succeeded.length > 0) {
                invalidateItemCreated(queryClient, targetOwnerId, targetMountId, targetParentId);
            }
            const failedCount = results.length - succeeded.length;
            if (failedCount > 0) {
                throw new Error(
                    failedCount === results.length
                        ? 'Failed to copy items'
                        : `Failed to copy ${failedCount} of ${results.length} items`,
                );
            }
            return succeeded;
        },
        onError: onMutationError,
    });
}

export function useDuplicatePath() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ items }: { items: DrivePath[] }) => {
            const results = await Promise.allSettled(
                items.map(async (item) => {
                    if (!item.parentId) throw new Error('Cannot duplicate a root item');
                    const response = await driveApi({ ownerId: item.ownerId })({ mountId: item.mountId })
                        .path({ pathId: item.id })
                        .copy.post({
                            targetOwnerId: item.ownerId,
                            targetMountId: item.mountId,
                            targetParentId: item.parentId,
                            name: `Copy of ${item.name}`,
                        });
                    if (response.error) throw new AppError(response);
                    return response.data;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            for (const item of succeeded) {
                invalidateItemCreated(queryClient, item.ownerId, item.mountId, item.parentId);
            }
            const failedCount = results.length - succeeded.length;
            if (failedCount > 0) {
                throw new Error(
                    failedCount === results.length
                        ? 'Failed to duplicate items'
                        : `Failed to duplicate ${failedCount} of ${results.length} items`,
                );
            }
            return succeeded;
        },
        onError: onMutationError,
    });
}

export function useRenamePath(
    ownerId: string,
    mountId: string = DEFAULT_MOUNT_ID,
    parentId?: string,
    mimeType?: string,
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ pathId, newName }: { pathId: string; newName: string }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).rename.put({ newName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidatePathRenamed(queryClient, ownerId, mountId, variables.pathId, parentId, mimeType),
        onError: onMutationError,
    });
}

// UPDATE ACL
export function useUpdateACL(ownerId: string, mountId: string = DEFAULT_MOUNT_ID, currentUserId?: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            path,
            add,
            remove,
            visibility,
            sharingRestricted,
        }: {
            path: DrivePath;
            add?: DriveACL[];
            remove?: string[];
            visibility?: DriveVisibility;
            sharingRestricted?: boolean;
        }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId: path.id }).acl.put({
                add,
                remove,
                visibility,
                sharingRestricted,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => {
            invalidateAclUpdated(
                queryClient,
                ownerId,
                variables.path.mountId,
                variables.path.id,
                variables.path.parentId,
                variables.path.mimeType,
            );
            // Invalidate the current user's shared-with-me (ownerId is the document owner, not the current user)
            if (currentUserId && currentUserId !== ownerId) {
                invalidateAclSharedOrUnshared(queryClient, currentUserId);
            }
            // Invalidate collab info so canWrite refreshes in document views
            queryClient.invalidateQueries({
                queryKey: collabKeys.document(ownerId, variables.path.mountId, variables.path.id),
            });
            toast.success('Sharing updated');
        },
        onError: onMutationError,
    });
}

// EMAIL COLLABORATORS
export function useEmailCollaborators(ownerId: string, mountId: string) {
    return useMutation({
        mutationFn: async ({
            pathId,
            subject,
            message,
            sendCopyToSelf,
        }: {
            pathId: string;
            subject: string;
            message: string;
            sendCopyToSelf: boolean;
        }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId })['email-collaborators'].post({
                subject,
                message,
                sendCopyToSelf,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => toast.success('Email sent'),
        onError: onMutationError,
    });
}

// CHECK PERMISSIONS (read + write in a single request)
export function useCheckPermissions(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.permissions(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return { canRead: false, canWrite: false };
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).permissions.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// EFFECTIVE MEMBERS (teams expanded, ancestors walked, deduplicated)
export function useEffectiveMembers(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.effectiveMembers(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId })['effective-members'].get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
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

const EIGENDOC_MIME: Record<EigenDocType, string> = {
    doc: DRIVE_MIME_DOC,
    stickies: DRIVE_MIME_STICKIES,
    slides: DRIVE_MIME_SLIDES,
    sheets: DRIVE_MIME_SHEETS,
    chat: DRIVE_MIME_CHAT,
};

export function useCreateDriveItem(type: EigenDocType) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            ownerId,
            mountId,
            parentId,
            fileName,
        }: {
            ownerId: string;
            mountId: string;
            parentId: string;
            fileName: string;
        }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .create({ type })
                .post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(
                queryClient,
                variables.ownerId,
                variables.mountId,
                variables.parentId,
                EIGENDOC_MIME[type],
            ),
        onError: onMutationError,
    });
}

export function useSharedPaths(ownerId: string, to: 'by-me' | 'with-me') {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.shared(ownerId, to),
        queryFn: async () => {
            if (to === 'by-me') {
                const response = await driveApi({ ownerId }).shared['by-me'].get();
                if (response.error) throw new AppError(response);
                return response.data;
            } else {
                const response = await driveApi({ ownerId }).shared['with-me'].get();
                if (response.error) throw new AppError(response);
                return response.data;
            }
        },
        enabled: !!ownerId,
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

// LIST TRASH
export function useListTrash(ownerId: string, mountId: string) {
    return useQuery({
        queryKey: driveKeys.trashList(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).trash.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// RESTORE PATH FROM TRASH
export function useRestorePath(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).trash({ pathId }).restore.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}

// PERMANENTLY DELETE FROM TRASH
export function usePermanentlyDelete(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).trash({ pathId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}

// EMPTY TRASH
export function useEmptyTrash(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).trash.delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateTrash(queryClient, ownerId, mountId),
        onError: onMutationError,
    });
}

// REQUEST ACCESS
export function useRequestAccess(ownerId: string, mountId: string, pathId: string) {
    return useMutation({
        mutationFn: async (body: { message?: string }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId })['request-access'].post(body);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onError: onMutationError,
    });
}

// SSE invalidation functions
export function invalidateAclSharedOrUnshared(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'with-me') });
}

export function invalidateItemCreated(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    parentId: string | null | undefined,
    mimeType?: string | null,
): void {
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateItemDeleted(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    queryClient.removeQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidatePathRenamed(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: collabKeys.document(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
}

export function invalidatePathMoved(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    oldParentId: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (oldParentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, oldParentId) });
    }
}

export function invalidateAclUpdated(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'by-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.permissions(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    // The eigendoc app listings (stickies/docs/slides/sheets) render from the mime-type
    // queries and pass their row objects into the share dialog — without this, the dialog
    // reopens on a stale ACL after a change made from those views.
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
}

export function invalidateTrash(queryClient: QueryClient, ownerId: string, mountId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.trashList(ownerId, mountId) });
}

// Owner-broad prefix invalidation: an ancestor ACL change alters effective membership for every
// descendant, so per-path invalidation is insufficient — drop the whole effective-members family.
export function invalidateEffectiveMembers(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: [...driveKeys.owner(ownerId), 'effective-members'] });
}
