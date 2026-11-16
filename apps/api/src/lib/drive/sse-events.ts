// Builds the drive events that tell open tabs a file or folder changed, so they refetch it. An event names the path by
// its ids and nothing more, so the path's name and ACL never travel on the stream. broadcastToOwnerAndMembers sends one
// to the owner and to everyone who can read the path, such as a team's members or the people a folder above it is
// shared with. Another domain's event about a path, such as a chat's, goes out through it too.

import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { SSEvent, SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { broadcastToHomes } from '../home/home-relay';
import { getUsersByEmails } from '../user';

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
    members: readonly EffectiveMember[] | Promise<readonly EffectiveMember[]>,
): Promise<void> {
    await broadcastToOwnerAndMembers(ownerId, members, buildDriveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED, path));
}

// Tells the open tabs of the owner and of each member who can read the path: a member without read cannot list it, so
// the event would name a path they may not see. The owner's copy goes first, so a failed read costs only the members'.
export async function broadcastToOwnerAndMembers(
    ownerId: string,
    members: readonly EffectiveMember[] | Promise<readonly EffectiveMember[]>,
    event: SSEvent,
): Promise<void> {
    broadcastToHomes([ownerId], event);
    const emails = (await members).filter((member) => member.read).map((member) => member.email);
    const readers = await getUsersByEmails([...new Set(emails)]);
    broadcastToHomes(
        readers.filter((user) => user.id !== ownerId).map((user) => user.id),
        event,
    );
}
