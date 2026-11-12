// The hooks that change Drive, such as create, upload, copy, move, rename and delete. Each one sends its
// request per item and then calls the invalidators for the listings the change makes stale. A batch goes
// through settleEach: when only part of it goes through, the hook says which items did, so a dialog can
// retry the rest and an editor can keep what landed.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { driveApi, getDriveAppUrl, getDriveFileUploadUrl, openDocument } from '@workspace/lib/api';
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

// Thrown when only part of a batch went through, with what the writes returned (for a copy, the copies) and the
// items that failed, so a dialog retries only those. Its message ends with the first failure's reason.
export class PartialBatchError extends Error {
    public constructor(
        verb: string,
        public readonly succeeded: readonly DrivePath[],
        public readonly failed: readonly DrivePath[],
        firstFailure: unknown,
    ) {
        super(
            `Failed to ${verb} ${failed.length} of ${succeeded.length + failed.length} items: ${getErrorMessage(firstFailure)}`,
            { cause: firstFailure },
        );
        this.name = 'PartialBatchError';
    }
}

// Sends one write per item, all at once, and refreshes what went through before it reports the rest. When
// nothing went through, the server's own error says best what went wrong, and a retry sends everything again.
export async function settleEach(
    verb: string,
    items: readonly DrivePath[],
    write: (item: DrivePath) => Promise<DrivePath>,
    refresh: (succeeded: readonly DrivePath[]) => void,
): Promise<DrivePath[]> {
    const results = await Promise.allSettled(items.map(write));
    const succeeded = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    refresh(succeeded);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (!rejected) return succeeded;
    if (succeeded.length === 0) throw rejected.reason;
    const failed = items.filter((_, i) => results[i].status === 'rejected');
    throw new PartialBatchError(verb, succeeded, failed, rejected.reason);
}

// Each path names its own owner and mount, so a selection from several drives reaches each home. An
// aggregate filter view, for example, lists other owners' items.
export function useDeletePaths() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    return useMutation({
        mutationFn: (paths: readonly DrivePath[]) =>
            settleEach(
                'delete',
                paths,
                async (path) => {
                    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                        .path({ pathId: path.id })
                        .delete();
                    if (response.error) throw new AppError(response);
                    return path;
                },
                (deleted) => {
                    for (const path of deleted) invalidateItemDeleted(queryClient, path);
                    // Deleting a direct share leaves it, which drops the row from the caller's shared-with-me list.
                    if (user) invalidateAclSharedOrUnshared(queryClient, user.id);
                },
            ),
        onError: onMutationError,
    });
}

// A move stays inside one drive, so the target folder is looked up in each item's own.
export function useMovePaths() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ paths, targetParentId }: { paths: readonly DrivePath[]; targetParentId: string }) =>
            settleEach(
                'move',
                paths,
                async (path) => {
                    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                        .path({ pathId: path.id })
                        .move.put({ targetParentId });
                    if (response.error) throw new AppError(response);
                    return path;
                },
                (moved) => {
                    for (const path of moved) invalidatePathMoved(queryClient, path, targetParentId);
                },
            ),
        onError: onMutationError,
    });
}

// Each copy lands beside its original, named "Copy of" it, as Make a copy does.
export function useDuplicatePaths() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (sources: readonly DrivePath[]) => copyEach(queryClient, sources, besideOriginal),
        onError: onMutationError,
    });
}

// Every item goes into one folder, and the toast offers to open it.
export function useCopyToFolder() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ items, ...target }: { items: readonly DrivePath[] } & CopyTarget) =>
            copyEach(queryClient, items, () => target),
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

// An open document's Make a copy. The user stays in the original, so the toast offers to open the copy.
export function useMakeCopy() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (source: DrivePath) => {
            const [copy] = await copyEach(queryClient, [source], besideOriginal);
            return copy;
        },
        onSuccess: (copy) => {
            toast.success('Copy made', { action: { label: 'Open', onClick: () => openDocument(copy) } });
        },
        onError: onMutationError,
    });
}

// Copies files into the media folder of a document or a chat. After a partial failure the toast says so and
// the copies that landed come back, so the editor can still insert them.
export function useCopyToMediaFolder(ownerId: string, mountId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ paths, mediaFolderId }: { paths: readonly DrivePath[]; mediaFolderId: string }) => {
            const target = { targetOwnerId: ownerId, targetMountId: mountId, targetParentId: mediaFolderId };
            return copyEach(queryClient, paths, () => target).catch((error: unknown) => {
                if (!(error instanceof PartialBatchError)) throw error;
                onMutationError(error);
                return error.succeeded;
            });
        },
        onError: onMutationError,
    });
}

export function useRenamePath() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ path, newName }: { path: DrivePath; newName: string }) => {
            const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                .path({ pathId: path.id })
                .rename.put({ newName });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, { path }) => invalidatePathRenamed(queryClient, path),
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

type CopyTarget = {
    targetOwnerId: string;
    targetMountId: string;
    targetParentId: string;
    name?: string;
};

// The server gives each copy into one folder its own free name, however many arrive together.
function copyEach(
    queryClient: QueryClient,
    sources: readonly DrivePath[],
    targetOf: (source: DrivePath) => CopyTarget,
): Promise<DrivePath[]> {
    return settleEach(
        'copy',
        sources,
        async (source) => {
            const response = await driveApi({ ownerId: source.ownerId })({ mountId: source.mountId })
                .path({ pathId: source.id })
                .copy.post(targetOf(source));
            if (response.error) throw new AppError(response);
            return response.data;
        },
        (copied) => {
            // One refresh per folder that got copies, however many landed in it.
            const folders = new Map(copied.map((path) => [`${path.ownerId}/${path.mountId}/${path.parentId}`, path]));
            for (const path of folders.values()) {
                invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            }
        },
    );
}

function besideOriginal(source: DrivePath): CopyTarget {
    if (!source.parentId) throw new Error('A root has no folder to hold its copy');
    return {
        targetOwnerId: source.ownerId,
        targetMountId: source.mountId,
        targetParentId: source.parentId,
        name: `Copy of ${source.name}`,
    };
}
