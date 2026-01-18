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
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
            return true;

        case SSEventType.DRIVE_FOLDER_CREATED:
        case SSEventType.DRIVE_FILE_UPLOADED:
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            queryClient.invalidateQueries({queryKey: driveKeys.folders()});
            queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.DRIVE_PATH_RENAMED:
        case SSEventType.DRIVE_PATH_MOVED:
            queryClient.invalidateQueries({queryKey: driveKeys.all});
            queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
            return true;

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
