import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {driveKeys} from './hooks/use-drive';
import {invalidateHomeSize} from '../home';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const {path} = event;

    switch (event.type) {
        // API: Item shared/unshared with current user → invalidate shared-with-me list
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
            return true;

        // API: New item created in parent folder → invalidate parent folder listing + home size
        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_UPLOADED:
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            invalidateHomeSize(queryClient);
            return true;

        // API: Item deleted → invalidate parent folder, remove path cache, invalidate mime type list, update home size
        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            queryClient.removeQueries({queryKey: driveKeys.path(path.id)});
            if (path.mimeType) {
                queryClient.invalidateQueries({queryKey: driveKeys.mime(path.mimeType)});
            }
            invalidateHomeSize(queryClient);
            return true;

        // API: Item name changed → invalidate path info, parent folder listing (shows name), mime type list (shows name)
        case SSEventType.DRIVE_PATH_RENAMED:
            queryClient.invalidateQueries({queryKey: driveKeys.path(path.id)});
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            if (path.mimeType) {
                queryClient.invalidateQueries({queryKey: driveKeys.mime(path.mimeType)});
            }
            return true;

        // API: Item moved to new parent → invalidate path info, new parent folder, old parent folder
        case SSEventType.DRIVE_PATH_MOVED:
            queryClient.invalidateQueries({queryKey: driveKeys.path(path.id)});
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            if (event.drive?.oldParentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(event.drive.oldParentId)});
            }
            return true;

        // API: Sharing permissions changed → invalidate both shared lists, path info (has ACL), parent folder
        case SSEventType.DRIVE_ACL_UPDATED:
            queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
            queryClient.invalidateQueries({queryKey: driveKeys.path(path.id)});
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            return true;

        default:
            return false;
    }
}
