import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { collabKeys } from '../collab/hooks/use-collab';
import { invalidateSearchOwner } from '../search';
import {
    driveKeys,
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathMoved,
    invalidatePathRenamed,
    invalidateTrash,
} from './hooks/use-drive';
import { invalidateFileHistory } from './hooks/use-file-history';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId?: string): boolean {
    if (!event?.type?.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const { path } = event;

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            queryClient.invalidateQueries({ queryKey: collabKeys.document(path.ownerId, path.mountId, path.id) });
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_CREATED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_FILE_UPLOADED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            // Overwrite re-uploads to an existing path: refresh the file's own detail too — size,
            // updatedAt, the thumbnail ?v= cache-bust and the text-preview key all derive from it,
            // so the parent-folder invalidation alone leaves an open detail/preview stale.
            queryClient.invalidateQueries({ queryKey: driveKeys.path(path.ownerId, path.mountId, path.id) });
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            invalidateItemDeleted(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_PATH_RENAMED:
            invalidatePathRenamed(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_PATH_MOVED:
            invalidatePathMoved(queryClient, path.ownerId, path.mountId, path.id, path.parentId, event.oldParentId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_ACL_UPDATED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_PATH_TRASHED:
            if (event.oldParentId) {
                invalidateItemDeleted(
                    queryClient,
                    path.ownerId,
                    path.mountId,
                    path.id,
                    event.oldParentId,
                    path.mimeType,
                );
            }
            invalidateTrash(queryClient, path.ownerId, path.mountId);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_PATH_RESTORED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            invalidateTrash(queryClient, path.ownerId, path.mountId);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        default:
            return false;
    }
}
