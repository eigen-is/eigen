// Builds the drive events that tell open tabs a file or folder changed, so they refetch it. An event
// names the path by its ids and nothing more, so the path's name and ACL never travel on the stream.
// Most go to the owner's own tabs. A change to a file's history also goes to everyone the file is
// shared with.

import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { relayEventToMembers, sendToHome } from '../home/home-relay';

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

// Only homes that are open receive it, so a closed home costs nothing. Callers don't wait for it, so a
// failed broadcast never fails or slows the change it reports.
export async function broadcastFileHistoryUpdated(
    ownerId: string,
    path: SSEventDrive['path'],
    members: EffectiveMember[],
): Promise<void> {
    const event = buildDriveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED, path);
    await Promise.all([
        sendToHome(ownerId, { type: 'broadcast', event }).catch(() => {}),
        relayEventToMembers(members, event),
    ]);
}
