// The hooks that change Drive, such as create, upload, copy, move, rename and delete. Each one sends its
// request per item and then calls the invalidators for the listings the change makes stale. When only part
// of a batch goes through, the hook says which items did, so a dialog can retry the rest and an editor can
// keep what landed.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { driveApi, getDriveAppUrl, getDriveFileUploadUrl } from '@workspace/lib/api';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO, withEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { toast } from 'sonner';
import { AppError, getErrorMessage, onMutationError } from '../../api-error';
import { useAuth } from '../../auth';
import { CREATE_TIMEOUT_MS, createWithReconcile, fetchListingOnce } from '../reconcile-create';
import {
    invalidateAclSharedOrUnshared,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathMoved,
    invalidatePathRenamed,
} from './keys';
import { folderContentQueryConfig } from './reads';

// Owner and mount come with each call, so one instance can create a folder in any drive.
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
            // Raw fetch bypasses Eden's Date reviver, so the dates arrive as strings and are revived here.
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

// Thrown by useDeletePaths when only part of a batch went to the trash: carries the paths that did and the
// ones that didn't, so a caller can run its after-delete steps for the paths that went and retry only the
// rest. A path sent again after it is in the trash answers 404.
export class PartialDeleteError extends Error {
    public constructor(
        public readonly succeeded: readonly DrivePath[],
        public readonly failed: readonly DrivePath[],
    ) {
        super(`Failed to delete ${failed.length} of ${succeeded.length + failed.length} items`);
        this.name = 'PartialDeleteError';
    }
}

// Each path names its own owner and mount, so a selection from several drives reaches each home. An
// aggregate filter view, for example, lists other owners' items.
export function useDeletePaths() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    return useMutation({
        mutationFn: async (paths: readonly DrivePath[]) => {
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
            // Deleting a direct share leaves it, which drops the row from the caller's shared-with-me list.
            if (user) invalidateAclSharedOrUnshared(queryClient, user.id);
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

// Thrown by the copy hooks when only part of a batch copied. It carries the copies that landed and the
// sources that didn't, so a caller can keep the copies and narrow a retry to the failures. A source sent
// again would land a second time, under a free name. Its message ends with the first failure's reason.
export class PartialCopyError extends Error {
    public constructor(
        public readonly copied: DrivePath[],
        public readonly failed: DrivePath[],
        firstFailure: unknown,
    ) {
        super(
            `Failed to copy ${failed.length} of ${copied.length + failed.length} items: ${getErrorMessage(firstFailure)}`,
            { cause: firstFailure },
        );
        this.name = 'PartialCopyError';
    }
}

type DriveCopy = {
    source: DrivePath;
    targetOwnerId: string;
    targetMountId: string;
    targetParentId: string;
    name?: string;
};

// Each copy names its own target folder, so one batch can fill several folders, as Duplicate does.
export function useCopyPaths() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (copies: readonly DriveCopy[]) => copyEach(queryClient, copies),
        onError: onMutationError,
    });
}

// Every item goes into one folder, and the toast offers to open it.
export function useCopyToFolder() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            items,
            ...target
        }: {
            items: readonly DrivePath[];
            targetOwnerId: string;
            targetMountId: string;
            targetParentId: string;
        }) =>
            copyEach(
                queryClient,
                items.map((source) => ({ source, ...target })),
            ),
        onSuccess: (copied, { targetOwnerId, targetMountId, targetParentId }) => {
            toast.success(copied.length === 1 ? '1 item copied' : `${copied.length} items copied`, {
                action: {
                    label: 'Open folder',
                    onClick: () => {
                        window.location.href = getDriveAppUrl(`fs/${targetOwnerId}/${targetMountId}/${targetParentId}`);
                    },
                },
            });
        },
        onError: onMutationError,
    });
}

// Copies files into the media folder of a document or a chat. When only part of the batch copies, the
// toast says so and the copies that landed come back, so the caller can still use them. When nothing
// copies it throws, so a caller such as a card's Save can stop.
export function useCopyToMediaFolder(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ paths, mediaFolderId }: { paths: readonly DrivePath[]; mediaFolderId: string }) => {
            const target = { targetOwnerId: ownerId, targetMountId: mountId, targetParentId: mediaFolderId };
            return copyEach(
                queryClient,
                paths.map((source) => ({ source, ...target })),
            ).catch((error: unknown) => {
                if (!(error instanceof PartialCopyError)) throw error;
                onMutationError(error);
                return error.copied;
            });
        },
        onError: onMutationError,
    });
}

// The server gives each copy a free name, so two copies sent into one folder at once could pick the same
// one. Copies into one folder therefore go one after another, and copies into different folders go at once.
async function copyEach(queryClient: QueryClient, copies: readonly DriveCopy[]): Promise<DrivePath[]> {
    const lastInFolder = new Map<string, Promise<unknown>>();
    const results = await Promise.allSettled(
        copies.map(({ source, ...body }) => {
            const folder = `${body.targetOwnerId}/${body.targetMountId}/${body.targetParentId}`;
            const sent = (lastInFolder.get(folder) ?? Promise.resolve()).then(async () => {
                const response = await driveApi({ ownerId: source.ownerId })({ mountId: source.mountId })
                    .path({ pathId: source.id })
                    .copy.post(body);
                if (response.error) throw new AppError(response);
                return response.data;
            });
            // The next copy into this folder waits for this one, whether it lands or fails.
            lastInFolder.set(folder, Promise.allSettled([sent]));
            return sent;
        }),
    );
    const copied = results
        .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
        .map((r) => r.value);
    // One refresh per folder that got copies, however many landed in it.
    const targets = new Map(copied.map((path) => [`${path.ownerId}/${path.mountId}/${path.parentId}`, path]));
    for (const path of targets.values()) {
        invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
    }
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (!rejected) return copied;
    // When nothing copied, the server's own error says best what went wrong. A retry sends everything again.
    if (copied.length === 0) throw rejected.reason;
    const failed = copies.filter((_, i) => results[i].status === 'rejected').map((copy) => copy.source);
    throw new PartialCopyError(copied, failed, rejected.reason);
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

// The create waits CREATE_TIMEOUT_MS. Then it reads the parent listing, so an item that slow storage did
// store is not reported as a failure.
export function useCreateDriveItem(type: EigenDocType) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            ownerId,
            mountId,
            parentId,
            fileName,
        }: {
            ownerId: string;
            mountId: string;
            parentId: string;
            fileName: string;
        }): Promise<DrivePath> =>
            createWithReconcile({
                create: async () => {
                    const response = await driveApi({ ownerId })({ mountId })
                        .folder({ pathId: parentId })
                        .create({ type })
                        .post({ fileName }, { fetch: { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) } });
                    if (response.error) throw new AppError(response);
                    return response.data;
                },
                listFolder: () => fetchListingOnce(queryClient, folderContentQueryConfig(ownerId, mountId, parentId)),
                expectedName: withEigenExtension(fileName, type),
            }),
        onSuccess: (_data, variables) =>
            invalidateItemCreated(
                queryClient,
                variables.ownerId,
                variables.mountId,
                variables.parentId,
                EIGEN_DOC_TYPE_INFO[type].mime,
            ),
        onError: onMutationError,
    });
}
