import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {toast} from 'sonner';
import {
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathMoved,
    invalidatePathRenamed
} from './hooks/use-drive';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId?: string): boolean {
    if (!event?.type?.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const {path} = event;

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            toast('Item shared with you', {description: `"${path.name}" was shared with you`});
            return true;

        case SSEventType.DRIVE_ACL_UNSHARED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            toast('Item unshared', {description: `"${path.name}" is no longer shared with you`});
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
            invalidatePathMoved(queryClient, path.ownerId, path.mountId, path.id, path.parentId, event.drive?.oldParentId);
            return true;

        case SSEventType.DRIVE_ACL_UPDATED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
            return true;

        default:
            return false;
    }
}
