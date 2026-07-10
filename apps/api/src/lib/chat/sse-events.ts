import type { EffectiveMember } from '@workspace/lib/types/drive';
import type { SSEvent, SSEventChat } from '@workspace/lib/types/sse';
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

// One relay loop for ChatRoom.notifySharedUsers and the route broadcast below, so the
// null-guard/try-catch behavior can't drift. sendToHome self-gates 'broadcast' on atHome().
export async function relayEventToMembers(members: EffectiveMember[], event: SSEvent): Promise<void> {
    await Promise.all(
        members.map(async (member) => {
            try {
                const user = await getUserByEmail(member.email);
                if (!user) return;
                await sendToHome(user.id, { type: 'broadcast', event });
            } catch {
                // user or home may not exist
            }
        }),
    );
}

// Mirrors ChatRoom's home.broadcast + notifySharedUsers pair: owner home + effective-member
// fan-out. Callers that already resolved the members (route validation) pass them in.
export async function broadcastCommentIndexUpdated(
    drive: Drive | SharedDrive,
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
