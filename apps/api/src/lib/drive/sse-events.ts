// Builds the drive events that tell open browser tabs a file or folder changed, so they refresh.
// A change to a file's history goes to everyone the file is shared with, not only its owner.

import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { relayEventToMembers, sendToHome } from '../home/home-relay';

export function buildDriveEvent(
    type: SSEventDrive['type'],
    path: SSEventDrive['path'],
    oldParentId?: string,
): SSEventDrive {
    return {
        type,
        path,
        ...(oldParentId && { oldParentId }),
    };
}

// Reaches the owner and everyone the file is shared with, so their open Activity panels refresh too.
// Only homes that are open receive it, so a closed home costs nothing. Callers don't wait for it:
// recording a change must never fail or slow down because of the broadcast.
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
