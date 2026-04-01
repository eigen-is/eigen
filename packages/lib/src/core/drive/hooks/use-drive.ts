import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi, getDriveFileUploadUrl } from '@workspace/lib/api';
import type { DriveACL, DrivePath, DriveVisibility } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { useCallback, useEffect, useRef, useState } from 'react';
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
    paths: (ownerId: string) => [...driveKeys.owner(ownerId), 'path'] as const,
    path: (ownerId: string, mountId: string, pathId: string) => [...driveKeys.paths(ownerId), mountId, pathId] as const,
    permissions: (ownerId: string) => [...driveKeys.owner(ownerId), 'permissions'] as const,
    read: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.permissions(ownerId), 'read', mountId, pathId] as const,
    write: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.permissions(ownerId), 'write', mountId, pathId] as const,
    shared: (ownerId: string, to: 'by-me' | 'with-me') => [...driveKeys.owner(ownerId), 'shared', to] as const,
    textPreviews: (ownerId: string) => [...driveKeys.owner(ownerId), 'text-preview'] as const,
    textPreview: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.textPreviews(ownerId), mountId, pathId] as const,
    effectiveMembers: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'effective-members', mountId, pathId] as const,
    trash: () => [...driveKeys.all, 'trash'] as const,
    trashList: (mountId: string) => [...driveKeys.trash(), mountId] as const,
};

// GET MOUNTS
export function useMounts(ownerId: string) {
    return useQuery({
        queryKey: driveKeys.mounts(ownerId),
        queryFn: async () => {
            const response = await driveApi({ ownerId }).mounts.get();
            return response.data || [];
        },
        staleTime: Infinity,
        enabled: !!ownerId,
    });
}

// GET ROOT FOLDER
export function useRootFolder(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    return useQuery<DrivePath | null>({
        queryKey: driveKeys.root(ownerId, mountId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).root.get();
            return response.data || null;
        },
        staleTime: Infinity,
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
            return response.data || [];
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

    return { contents: data, findByName };
}

// GET MIME CONTENTS (aggregates over all mounts)
export function useMimeContent(ownerId: string, mimeType: string) {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.mime(ownerId, mimeType),
        queryFn: async () => {
            if (!mimeType) return [];
            const response = await driveApi({ ownerId }).mime({ mimeType }).get();
            if (response.error) {
                throw new AppError(response);
            }
            return response.data || [];
        },
        enabled: !!mimeType && !!ownerId,
        retry: 1,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// GET PATH INFO
export function usePathInfo(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery<DrivePath | null>({
        queryKey: driveKeys.path(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return null;
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).get();
            return response.data || null;
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
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
            return data[0];
        },
        onSuccess: (_data, variables) => invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId),
        onError: onMutationError,
    });
}

// DELETE FOLDER
export function useDeleteFolder(
    ownerId: string,
    mountId: string = DEFAULT_MOUNT_ID,
    parentId?: string,
    mimeType?: string,
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, ownerId, mountId, pathId, parentId, mimeType),
        onError: onMutationError,
    });
}

// DELETE FILE
export function useDeleteFile(
    ownerId: string,
    mountId: string = DEFAULT_MOUNT_ID,
    parentId?: string,
    mimeType?: string,
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (pathId: string) => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, pathId) => invalidateItemDeleted(queryClient, ownerId, mountId, pathId, parentId, mimeType),
        onError: onMutationError,
    });
}

// DELETE MULTIPLE PATHS
export function useDeletePaths(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (paths: DrivePath[]) => {
            const results = await Promise.allSettled(
                paths.map(async (path) => {
                    const response =
                        path.type === 'folder'
                            ? await driveApi({ ownerId })({ mountId }).folder({ pathId: path.id }).delete()
                            : await driveApi({ ownerId })({ mountId }).file({ pathId: path.id }).delete();
                    if (response.error) throw new AppError(response);
                    return path;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            for (const path of succeeded) {
                invalidateItemDeleted(queryClient, ownerId, mountId, path.id, path.parentId, path.mimeType);
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
            acl,
            visibility,
            sharingRestricted,
        }: {
            path: DrivePath;
            acl: DriveACL[];
            visibility?: DriveVisibility;
            sharingRestricted?: boolean;
        }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId: path.id }).acl.put({
                acl,
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
            );
            // Invalidate the current user's shared-with-me (ownerId is the document owner, not the current user)
            if (currentUserId && currentUserId !== ownerId) {
                invalidateAclSharedOrUnshared(queryClient, currentUserId);
            }
            // Invalidate collab info so canWrite refreshes in document views
            queryClient.invalidateQueries({
                queryKey: ['collab', 'info', ownerId, variables.path.mountId, variables.path.id],
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
            documentUrl,
            sendCopyToSelf,
        }: {
            pathId: string;
            subject: string;
            message: string;
            documentUrl: string;
            sendCopyToSelf: boolean;
        }) => {
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId })['email-collaborators'].post({
                subject,
                message,
                documentUrl,
                sendCopyToSelf,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => toast.success('Email sent'),
        onError: onMutationError,
    });
}

// CHECK READ PERMISSION
export function useCheckReadPermission(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.read(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return { canRead: false };
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).permissions.read.get();
            return response.data || { canRead: false };
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// CHECK WRITE PERMISSION
export function useCheckWritePermission(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.write(ownerId, mountId, pathId || ''),
        queryFn: async () => {
            if (!pathId) return { canWrite: false };
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).permissions.write.get();
            return response.data || { canWrite: false };
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
            return response.data || [];
        },
        enabled: !!pathId && !!ownerId && !!mountId,
    });
}

// GET BREADCRUMB PATH
export function useBreadcrumb(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery<DrivePath[]>({
        queryKey: [...driveKeys.path(ownerId, mountId, pathId || ''), 'breadcrumb'],
        queryFn: async () => {
            if (!pathId) return [];
            const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).breadcrumb.get();
            return response.data || [];
        },
        enabled: !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

// CREATE DOC
export function useCreateDoc(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, fileName }: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .doc.post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_DOC'),
        onError: onMutationError,
    });
}

// CREATE STICKIES
export function useCreateStickies(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, fileName }: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .stickies.post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_STICKIES'),
        onError: onMutationError,
    });
}

// CREATE SLIDES
export function useCreateSlides(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, fileName }: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .slides.post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_SLIDES'),
        onError: onMutationError,
    });
}

// CREATE SHEETS
export function useCreateSheets(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ parentId, fileName }: { parentId: string; fileName: string }): Promise<DrivePath> => {
            const response = await driveApi({ ownerId })({ mountId })
                .folder({ pathId: parentId })
                .sheets.post({ fileName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) =>
            invalidateItemCreated(queryClient, ownerId, mountId, variables.parentId, 'DRIVE_MIME_SHEETS'),
        onError: onMutationError,
    });
}

export function useSharedPaths(ownerId: string, to: 'by-me' | 'with-me') {
    return useQuery<DrivePath[]>({
        queryKey: driveKeys.shared(ownerId, to),
        queryFn: async () => {
            if (to === 'by-me') {
                const response = await driveApi({ ownerId }).shared['by-me'].get();
                return response.data || [];
            } else {
                const response = await driveApi({ ownerId }).shared['with-me'].get();
                return response.data || [];
            }
        },
        enabled: !!ownerId,
    });
}

// TEXT PREVIEW
export function useTextPreview(ownerId: string, mountId: string, pathId: string, enabled: boolean) {
    return useQuery({
        queryKey: driveKeys.textPreview(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId })['text-preview'].get();
            if (response.error) throw new AppError(response);
            return response.data as { body: string; mode: string } | null;
        },
        enabled: enabled && !!pathId && !!ownerId && !!mountId,
        staleTime: 1000 * 60 * 5,
    });
}

// LIST TRASH
export function useListTrash(ownerId: string, mountId: string) {
    return useQuery({
        queryKey: driveKeys.trashList(mountId),
        queryFn: async () => {
            const { data, error } = await driveApi({ ownerId })({ mountId }).trash.get();
            if (error) throw error;
            return data;
        },
        enabled: !!ownerId && !!mountId,
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
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({ queryKey: driveKeys.mime(ownerId, normalizedMimeType) });
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
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({ queryKey: driveKeys.mime(ownerId, normalizedMimeType) });
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
        const normalizedMimeType = mimeType.replace('/', '-');
        queryClient.invalidateQueries({ queryKey: driveKeys.mime(ownerId, normalizedMimeType) });
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
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'by-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.read(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.write(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
}

export function invalidateTrash(queryClient: QueryClient, _ownerId: string, mountId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.trashList(mountId) });
}
