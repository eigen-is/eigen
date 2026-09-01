import { useMutation, useQueryClient } from '@tanstack/react-query';
import { driveApi, getDriveAppUrl, getDriveFileUploadUrl } from '@workspace/lib/api';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_MIME_VECTOR,
    type DrivePath,
    type EigenDocType,
} from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { partitionCopyResults } from './copy-media-partition';
import { invalidateItemCreated, invalidateItemDeleted, invalidatePathMoved, invalidatePathRenamed } from './keys';

// CREATE FOLDER — owner/mount come per call so one instance serves any target drive.
export function useCreateFolder() {
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

// Thrown by useDeletePaths when a batch trash partially fails: carries the paths that were trashed and
// the ones that weren't, so the caller can run its after-delete side effects for the successes and narrow
// a retry to just the failures (re-sending already-trashed ids 404s).
export class PartialDeleteError extends Error {
    constructor(
        readonly succeeded: DrivePath[],
        readonly failed: DrivePath[],
    ) {
        super(`Failed to delete ${failed.length} of ${succeeded.length + failed.length} items`);
        this.name = 'PartialDeleteError';
    }
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
            const failed = paths.filter((_, i) => results[i].status === 'rejected');
            if (failed.length > 0) throw new PartialDeleteError(succeeded, failed);
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
            const { copied, failedCount } = partitionCopyResults(results);
            if (copied.length > 0) {
                invalidateItemCreated(queryClient, ownerId, mountId, mediaFolderId);
            }
            // Total failure throws so onMutationError toasts and card-attachments' Save-abort stays intact;
            // a partial failure keeps the successes and only warns about the ones that dropped.
            if (failedCount > 0 && copied.length === 0) throw new Error('Failed to copy files');
            if (failedCount > 0) {
                toast.error(`${failedCount} file${failedCount === 1 ? '' : 's'} could not be copied`);
            }
            return copied;
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
            const { copied, failedCount } = partitionCopyResults(results);
            if (copied.length > 0) {
                invalidateItemCreated(queryClient, targetOwnerId, targetMountId, targetParentId);
            }
            if (failedCount > 0) {
                throw new Error(
                    failedCount === results.length
                        ? 'Failed to copy items'
                        : `Failed to copy ${failedCount} of ${results.length} items`,
                );
            }
            return copied;
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
            const { copied, failedCount } = partitionCopyResults(results);
            for (const item of copied) {
                invalidateItemCreated(queryClient, item.ownerId, item.mountId, item.parentId);
            }
            if (failedCount > 0) {
                throw new Error(
                    failedCount === results.length
                        ? 'Failed to duplicate items'
                        : `Failed to duplicate ${failedCount} of ${results.length} items`,
                );
            }
            return copied;
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

const EIGENDOC_MIME: Record<EigenDocType, string> = {
    doc: DRIVE_MIME_DOC,
    stickies: DRIVE_MIME_STICKIES,
    slides: DRIVE_MIME_SLIDES,
    sheets: DRIVE_MIME_SHEETS,
    chat: DRIVE_MIME_CHAT,
    vector: DRIVE_MIME_VECTOR,
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
