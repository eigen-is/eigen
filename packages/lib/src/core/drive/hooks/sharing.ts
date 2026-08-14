import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DriveACL, DriveAccessCheckResult, DrivePath, DriveVisibility } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { collabKeys } from '../../collab/hooks/keys';
import { driveKeys, invalidateAclSharedOrUnshared, invalidateAclUpdated } from './keys';

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
        staleTime: STALE_TIME.FIVE_MINUTES,
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
        staleTime: STALE_TIME.FIVE_MINUTES,
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
        staleTime: STALE_TIME.FIVE_MINUTES,
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

// CHECK ACCESS FOR EMAILS — imperative, time-of-send probe for the mail share-and-send dialog. Not a
// query hook: the answer is only good at the moment of send and must never be cached or reused.
export async function checkPathAccess(
    ownerId: string,
    mountId: string,
    pathId: string,
    emails: string[],
): Promise<DriveAccessCheckResult> {
    const response = await driveApi({ ownerId })({ mountId }).path({ pathId })['access-check'].post({ emails });
    if (response.error) throw new AppError(response);
    return response.data;
}
