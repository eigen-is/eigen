// A document's saved versions: the list, Save version now, a restore and Delete history, each a query or a mutation
// on the versions routes of one document. The File menu's version rows use them, and so does the screen a document
// opens to when its stored data is gone.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateMessages } from '../../chat/hooks/keys';
import { invalidateVersions, versionsKeys } from './keys';

export function useVersions(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: versionsKeys.container(ownerId, mountId, pathId),
        queryFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).versions.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

export function useSaveVersion(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).versions.save.post();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateVersions(queryClient, ownerId, mountId, pathId);
            toast.success('Version saved');
        },
        onError: onMutationError,
    });
}

export function useRestoreVersion(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (snapshotName: string) => {
            const response = await driveApi({ ownerId })({ mountId })
                .file({ pathId })
                .versions({ snapshotName })
                .restore.post();
            if (response.error) throw new AppError(response);
        },
        onSuccess: () => {
            invalidateVersions(queryClient, ownerId, mountId, pathId);
            // A chat's restore replaces its data.db, so its messages are read again. A collab document needs
            // nothing here: the server sends the restored state to every open editor.
            invalidateMessages(queryClient, ownerId, mountId, pathId);
            toast.success('Version restored');
        },
        onError: onMutationError,
    });
}

// Delete history: every version of the document and of its comment threads. Only an owner of the drive may.
export function useDeleteVersions(ownerId: string, mountId: string, pathId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const response = await driveApi({ ownerId })({ mountId }).file({ pathId }).versions.delete();
            if (response.error) throw new AppError(response);
        },
        onSuccess: () => {
            invalidateVersions(queryClient, ownerId, mountId, pathId);
            toast.success('Version history deleted');
        },
        onError: onMutationError,
    });
}
