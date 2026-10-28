// Handles the drive events from the stream: each names one path, and the handler refetches the
// queries that show it, such as its folder listing, its own detail, the trash and the search results.
// handleSSEvent calls it for every event, and it ignores the events of the other domains.

import type { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import type { SSEvent, SSEventTypeName } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateChatMatches } from '../chat/hooks/keys';
import { invalidateSearchOwner } from '../search';
import {
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateEffectiveMembers,
    invalidateItemCreated,
    invalidateItemDeleted,
    invalidatePath,
    invalidatePathMoved,
    invalidatePathRenamed,
    invalidateTrash,
} from './hooks/keys';
import { invalidateFileHistory } from './hooks/use-file-history';

// A chat found by its members depends on its ACL, its place and whether it is live. A folder's ACL
// reaches the chats below it, and the items below a trashed, restored or deleted folder send no events
// of their own. So these events on any path refresh the cached lookups, not only a chat's.
const CHAT_MATCH_EVENTS = new Set<SSEventTypeName>([
    SSEventType.DRIVE_ACL_SHARED,
    SSEventType.DRIVE_ACL_UNSHARED,
    SSEventType.DRIVE_ACL_UPDATED,
    SSEventType.DRIVE_PATH_MOVED,
    SSEventType.DRIVE_PATH_TRASHED,
    SSEventType.DRIVE_PATH_RESTORED,
    SSEventType.DRIVE_FOLDER_DELETED,
]);

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    if (!('path' in event)) return;
    const { path } = event;

    if (path.mimeType === DRIVE_MIME_CHAT || CHAT_MATCH_EVENTS.has(event.type)) {
        invalidateChatMatches(queryClient, userId);
    }

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
        case SSEventType.DRIVE_ACL_UPDATED:
            invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateEffectiveMembers(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_CREATED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_FILE_UPLOADED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            // An overwrite keeps the path, so its own detail refetches too. The size, the thumbnail's
            // cache-bust and the text preview's key all come from it.
            invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            invalidateItemDeleted(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateTrash(queryClient, path.ownerId, path.mountId);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_PATH_RENAMED:
            invalidatePathRenamed(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_PATH_MOVED:
            invalidatePathMoved(queryClient, path.ownerId, path.mountId, path.id, path.parentId, event.oldParentId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

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
            break;

        case SSEventType.DRIVE_PATH_RESTORED:
            invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
            invalidateTrash(queryClient, path.ownerId, path.mountId);
            invalidateSearchOwner(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_FILE_HISTORY_UPDATED:
            invalidateFileHistory(queryClient, path.ownerId);
            break;
    }
}
