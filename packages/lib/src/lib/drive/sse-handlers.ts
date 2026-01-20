import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {
    invalidateAclSharedOrUnshared,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathRenamed,
    invalidatePathMoved,
    invalidateAclUpdated
} from './hooks/use-drive';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const {path} = event;

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            invalidateAclSharedOrUnshared(queryClient);
            return true;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_UPLOADED:
            invalidateItemCreated(queryClient, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            invalidateItemDeleted(queryClient, path.id, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_PATH_RENAMED:
            invalidatePathRenamed(queryClient, path.id, path.parentId, path.mimeType);
            return true;

        case SSEventType.DRIVE_PATH_MOVED:
            invalidatePathMoved(queryClient, path.id, path.parentId, event.drive?.oldParentId);
            return true;

        case SSEventType.DRIVE_ACL_UPDATED:
            invalidateAclUpdated(queryClient, path.id, path.parentId);
            return true;

        default:
            return false;
    }
}
