import type { SSEventChat } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Drive, SharedDrive } from '../drive';
import { sendToHome } from '../home/home-relay';
import { getUserByEmail } from '../user/';

export function buildChatEvent(type: SSEventChat['type'], chat: SSEventChat['chat']): SSEventChat {
    return { type, chat };
}

export function buildCommentIndexUpdatedEvent(containerId: string, ownerId: string, mountId: string): SSEventChat {
    return buildChatEvent(SSEventType.CHAT_COMMENT_INDEX_UPDATED, { chatId: containerId, ownerId, mountId });
}

// Mirrors ChatRoom's home.broadcast + notifySharedUsers pair: owner home + effective-member
// fan-out. sendToHome self-gates 'broadcast' on atHome(), so unloaded homes are skipped for free.
export async function broadcastCommentIndexUpdated(
    drive: Drive | SharedDrive,
    ownerId: string,
    mountId: string,
    containerId: string,
): Promise<void> {
    const event = buildCommentIndexUpdatedEvent(containerId, ownerId, mountId);
    const members = await drive.getEffectiveMembers(mountId, containerId);
    await Promise.all([
        sendToHome(ownerId, { type: 'broadcast', event }).catch(() => {}),
        ...members.map(async (member) => {
            try {
                const user = await getUserByEmail(member.email);
                if (!user) return;
                await sendToHome(user.id, { type: 'broadcast', event });
            } catch {
                // user or home may not exist
            }
        }),
    ]);
}
