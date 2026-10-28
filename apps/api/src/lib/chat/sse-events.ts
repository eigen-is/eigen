// Builds the chat events, which name a chat room by its owner, mount and id. A ChatRoom sends its message
// events itself. This file also sends the event for a document's changed comment index, for example
// after a comment in the document is resolved.

import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEventChat } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { DriveLike } from '../drive/get-drive';
import { broadcastToOwnerAndMembers } from '../home/home-relay';

export function buildChatEvent(type: SSEventChat['type'], chat: SSEventChat['chat']): SSEventChat {
    return { type, chat };
}

export function buildCommentIndexUpdatedEvent(ownerId: string, mountId: string, containerId: string): SSEventChat {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, { chatId: containerId, ownerId, mountId });
}

// Reaches the owner's tabs and every effective member's, the way a ChatRoom sends its own events. A
// caller that already read the members passes them, so they aren't read twice.
export async function broadcastCommentIndexUpdated(
    drive: DriveLike,
    ownerId: string,
    mountId: string,
    containerId: string,
    members?: EffectiveMember[],
): Promise<void> {
    await broadcastToOwnerAndMembers(
        ownerId,
        members ?? drive.getEffectiveMembers(mountId, containerId),
        buildCommentIndexUpdatedEvent(ownerId, mountId, containerId),
    );
}
