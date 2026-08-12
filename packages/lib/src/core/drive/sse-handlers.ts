import type { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateChatMatches } from '../chat/hooks/use-chat';
import { collabKeys } from '../collab/hooks/use-collab';
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

    // Chat by-members matches derive from ACLs, breadcrumbs and liveness — refresh the cached
    // lookups when a chat row changes, or on ACL/move/trash/restore/folder-delete events anywhere:
    // folder ACLs inherit down, and descendants of a trashed/restored/deleted folder emit no
    // events of their own (bulk SQL), so the folder's event must stand in for its chats.
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
            if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateEffectiveMembers(queryClient, path.ownerId);
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
            invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId, path.mimeType);
            invalidateEffectiveMembers(queryClient, path.ownerId);
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
