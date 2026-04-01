import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import {
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathMoved,
    invalidatePathRenamed,
    invalidateTrash,
} from './hooks/use-drive';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId?: string): boolean {
    if (!event?.type?.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const { path } = event;

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            return true;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_CREATED:
        case SSEventType.DRIVE_FILE_UPLOADED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            invalidateItemDeleted(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_PATH_RENAMED:
            invalidatePathRenamed(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_PATH_MOVED:
            invalidatePathMoved(queryClient, path.ownerId, path.mountId, path.id, path.parentId, event.oldParentId);
            return true;

        case SSEventType.DRIVE_ACL_UPDATED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
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
            return true;

        case SSEventType.DRIVE_PATH_RESTORED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            invalidateTrash(queryClient, path.ownerId, path.mountId);
            return true;

        default:
            return false;
    }
}
