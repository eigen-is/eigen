// Handles the drive events from the stream: each names one path, and the handler refetches the
// queries that show it, such as its folder listing, its own detail, the trash and the search results.
// useSSE calls it through handleSSEvent for every event; it ignores the other domains' events.

import type { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateChatMatches } from '../chat/hooks/keys';
import { invalidateSearchOwner } from '../search';
import {
    driveKeys,
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateEffectiveMembers,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePathMoved,
    invalidatePathRenamed,
    invalidateTrash,
} from './hooks/keys';
import { invalidateFileHistory } from './hooks/use-file-history';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId?: string): boolean {
    if (!event?.type?.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const { path } = event;

    // A chat found by its members depends on its ACL, its place and whether it is live. A folder's ACL
    // reaches the chats below it, and the items below a trashed, restored or deleted folder send no
    // events of their own. So those events on any path refresh the cached lookups, not only a chat's.
    const affectsChatMatches =
        path.mimeType === DRIVE_MIME_CHAT ||
        event.type === SSEventType.DRIVE_ACL_SHARED ||
        event.type === SSEventType.DRIVE_ACL_UNSHARED ||
        event.type === SSEventType.DRIVE_ACL_UPDATED ||
        event.type === SSEventType.DRIVE_PATH_MOVED ||
        event.type === SSEventType.DRIVE_PATH_TRASHED ||
        event.type === SSEventType.DRIVE_PATH_RESTORED ||
        event.type === SSEventType.DRIVE_FOLDER_DELETED;
    if (userId && affectsChatMatches) invalidateChatMatches(queryClient, userId);

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
        case SSEventType.DRIVE_ACL_UPDATED:
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateEffectiveMembers(queryClient, path.ownerId);
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
            // An overwrite keeps the path, so its own detail refetches too. The size, the thumbnail's
            // cache-bust and the text preview's key all come from it.
            queryClient.invalidateQueries({ queryKey: driveKeys.path(path.ownerId, path.mountId, path.id) });
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            invalidateItemDeleted(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateTrash(queryClient, path.ownerId, path.mountId);
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

        case SSEventType.DRIVE_FILE_HISTORY_UPDATED:
            invalidateFileHistory(queryClient, path.ownerId);
            return true;

        default:
            return false;
    }
}
