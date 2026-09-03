import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEventChat } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { DriveLike } from '../drive/get-drive';
import { relayEventToMembers, sendToHome } from '../home/home-relay';

export function buildChatEvent(type: SSEventChat['type'], chat: SSEventChat['chat']): SSEventChat {
    return { type, chat };
}

export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEventChat {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, { chatId: containerId, ownerId, mountId });
}

// Mirrors ChatRoom's home.broadcast + notifySharedUsers pair: owner home + effective-member
// fan-out. Callers that already resolved the members (route validation) pass them in.
export async function broadcastCommentIndexUpdated(
    drive: DriveLike,
    ownerId: string,
    mountId: string,
    containerId: string,
    members?: EffectiveMember[],
): Promise<void> {
    const event = buildCommentIndexUpdatedEvent(containerId, ownerId, mountId);
    const resolved = members ?? (await drive.getEffectiveMembers(mountId, containerId));
    await Promise.all([
        sendToHome(ownerId, { type: 'broadcast', event }).catch(() => {}),
        relayEventToMembers(resolved, event),
    ]);
}
