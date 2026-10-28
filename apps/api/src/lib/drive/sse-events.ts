// Builds the drive events that tell open tabs a file or folder changed, so they refetch it. An event
// names the path by its ids and nothing more, so the path's name and ACL never travel on the stream.
// Each goes to the owner and to everyone who can read the path, such as a team's members or the
// people a folder above it is shared with.

import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { broadcastToOwnerAndMembers } from '../home/home-relay';

// Callers pass a whole DrivePath, so the ids are picked here rather than spread.
export function buildDriveEvent(
    type: SSEventDrive['type'],
    path: SSEventDrive['path'],
    oldParentId?: string,
): SSEventDrive {
    const { ownerId, mountId, id, parentId, mimeType } = path;
    return {
        type,
        path: { ownerId, mountId, id, parentId, mimeType },
        ...(oldParentId && { oldParentId }),
    };
}

// Callers don't wait for it, so a failed broadcast never fails or slows the change it reports.
export async function broadcastFileHistoryUpdated(
    ownerId: string,
    path: SSEventDrive['path'],
    members: EffectiveMember[] | Promise<EffectiveMember[]>,
): Promise<void> {
    await broadcastToOwnerAndMembers(ownerId, members, buildDriveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED, path));
}
