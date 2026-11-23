// The hooks behind sharing a Drive item: changing its ACL, mailing its collaborators, asking for access, and
// reading who may open it, such as the viewer's own permissions, its effective members and the shared lists.
// Sharing UI such as the Share dialog calls them; checkPathAccess is the mail composer's one-off probe at send.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACL, DriveAccessCheckResult, DriveVisibility } from '@workspace/lib/types/drive-access';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { useAuth } from '../../auth';
import { driveKeys, invalidateAclUpdated, invalidateViewerLists } from './keys';

// The path names its own owner and mount, so one instance shares an item from any drive.
export function useUpdateACL() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
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
            const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
                .path({ pathId: path.id })
                .acl.put({ add, remove, visibility, sharingRestricted });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (_data, variables) => {
            invalidateAclUpdated(queryClient, variables.path);
            // A sharer other than the owner, such as an editor, has lists of their own.
            if (user && user.id !== variables.path.ownerId) invalidateViewerLists(queryClient, user.id);
            toast.success('Sharing updated');
        },
        onError: onMutationError,
    });
}

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

export function useCheckPermissions(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.permissions(ownerId, mountId, pathId || ''),
        queryFn:
            pathId && ownerId && mountId
                ? async () => {
                      const response = await driveApi({ ownerId })({ mountId }).path({ pathId }).permissions.get();
                      if (response.error) throw new AppError(response);
                      return response.data;
                  }
                : skipToken,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

// Teams expanded into their members and the folders above walked, each person once.
export function useEffectiveMembers(ownerId: string, mountId: string, pathId: string | undefined) {
    return useQuery({
        queryKey: driveKeys.effectiveMembers(ownerId, mountId, pathId || ''),
        queryFn:
            pathId && ownerId && mountId
                ? async () => {
                      const response = await driveApi({ ownerId })({ mountId })
                          .path({ pathId })
                          ['effective-members'].get();
                      if (response.error) throw new AppError(response);
                      return response.data;
                  }
                : skipToken,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useSharedPaths(ownerId: string, to: 'by-me' | 'with-me') {
    return useQuery({
        queryKey: driveKeys.shared(ownerId, to),
        queryFn: async () => {
            const response =
                to === 'by-me'
                    ? await driveApi({ ownerId }).shared['by-me'].get()
                    : await driveApi({ ownerId }).shared['with-me'].get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        enabled: !!ownerId,
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

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

// Not a query hook: the answer holds only at the moment of send, so it is never cached.
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
