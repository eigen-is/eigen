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

// Owner home + effective-member fan-out, mirroring chat's broadcastCommentIndexUpdated: unlike
// Drive.emit (owner-only home.broadcast), this reaches shared members' homes so their open
// Activity panels invalidate too. sendToHome self-gates 'broadcast' on atHome() — unloaded homes
// cost nothing. Fire-and-forget by callers: recording must never fail or slow on the broadcast.
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
