import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {driveKeys} from './hooks/use-drive';

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
            return true;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_UPLOADED:
            if (event.data.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
            }
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            queryClient.invalidateQueries({queryKey: driveKeys.folders()});
            queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
            return true;

        case SSEventType.DRIVE_PATH_RENAMED:
        case SSEventType.DRIVE_PATH_MOVED:
            queryClient.invalidateQueries({queryKey: driveKeys.all});
            queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
            return true;

        case SSEventType.DRIVE_ACL_UPDATED:
            queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
            if (event.data.pathId) {
                queryClient.invalidateQueries({queryKey: driveKeys.path(event.data.pathId)});
            }
            if (event.data.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
            }
            return true;

        default:
            return false;
    }
}
