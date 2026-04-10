import { driveApi, getCalendarAppUrl, getDriveAppUrl, getDriveItemUrl, getMailAppUrl } from '@workspace/lib/api';
import { getMonthRange } from '@workspace/lib/calendar';
import type { Notification } from '@workspace/lib/types/notification';

function parseDriveTag(
    tag: string,
    hasChatName = false,
): { ownerId: string; mountId: string; pathId: string; chatName?: string } | null {
    const parts = tag.split(':');
    if (
        !['share', 'mention', 'chat-message', 'comment-reply'].includes(parts[0]) ||
        !parts[1] ||
        !parts[2] ||
        !parts[3]
    )
        return null;
    return {
        ownerId: parts[1],
        mountId: parts[2],
        pathId: parts[3],
        chatName: hasChatName && parts[4] ? parts[4] : undefined,
    };
}

function parseAccessRequestTag(
    tag: string,
): { ownerId: string; mountId: string; pathId: string; email: string } | null {
    const parts = tag.split(':');
    if (parts[0] !== 'access-request' || !parts[1] || !parts[2] || !parts[3] || !parts[4]) return null;
    return { ownerId: parts[1], mountId: parts[2], pathId: parts[3], email: parts.slice(4).join(':') };
}

function parseCalendarInviteTag(tag: string): { eventId: string; startTime: number } | null {
    const parts = tag.split(':');
    if (parts[0] !== 'calendar-invite' || !parts[1]) return null;
    return { eventId: parts[1], startTime: parts[2] ? Number(parts[2]) || 0 : 0 };
}

async function resolveDriveLink(tag: string, hasChatName = false): Promise<string> {
    const parsed = parseDriveTag(tag, hasChatName);
    if (!parsed) return getDriveAppUrl();

    const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
        .path({ pathId: parsed.pathId })
        .get();
    if (response.error || !response.data) return getDriveAppUrl();

    const path = response.data;
    const itemUrl = getDriveItemUrl(path);
    if (itemUrl) {
        if (parsed.chatName) return `${itemUrl}?chat=${encodeURIComponent(parsed.chatName)}`;
        return itemUrl;
    }

    // Regular files (images, PDFs, etc.) open in shared-with-me with the file pre-selected
    return getDriveAppUrl(`shared/with-me?pid=${path.id}&uid=${path.ownerId}&mid=${path.mountId}`);
}

async function resolveAccessRequestLink(tag: string): Promise<string | null> {
    const parsed = parseAccessRequestTag(tag);
    if (!parsed) return null;

    const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
        .path({ pathId: parsed.pathId })
        .get();
    if (response.error || !response.data) return null;

    const parentId = response.data.parentId || response.data.id;
    return getDriveAppUrl(
        `fs/${parsed.ownerId}/${parsed.mountId}/${parentId}?sharePathId=${parsed.pathId}&shareEmail=${encodeURIComponent(parsed.email)}`,
    );
}

export function isClickableNotification(type: string): boolean {
    return [
        'share',
        'mention-chat',
        'mention-comment',
        'chat-message',
        'comment-reply',
        'calendar-share',
        'calendar-unshare',
        'calendar-invite',
        'calendar-invite-updated',
        'calendar-invite-cancelled',
        'mail',
        'access-request',
    ].includes(type);
}

export async function resolveNotificationLink(
    notification: Pick<Notification, 'type' | 'tag'>,
): Promise<string | null> {
    const { type, tag } = notification;
    if (!tag) return null;

    switch (type) {
        case 'mention-comment':
        case 'comment-reply':
            return resolveDriveLink(tag, true);

        case 'share':
        case 'mention-chat':
        case 'chat-message':
            return resolveDriveLink(tag);

        case 'calendar-invite':
        case 'calendar-invite-updated':
        case 'calendar-invite-cancelled': {
            const parsed = parseCalendarInviteTag(tag);
            if (parsed?.startTime) {
                const { from, to } = getMonthRange(new Date(parsed.startTime * 1000));
                return getCalendarAppUrl(`view/month/${from}/${to}?eventId=${encodeURIComponent(parsed.eventId)}`);
            }
            return getCalendarAppUrl();
        }

        case 'calendar-share':
        case 'calendar-unshare':
            return getCalendarAppUrl();

        case 'mail': {
            const mailId = tag.startsWith('mail:') ? tag.slice(5) : null;
            return getMailAppUrl(mailId ? `box/inbox?mailId=${encodeURIComponent(mailId)}` : 'box/inbox');
        }

        case 'access-request':
            return resolveAccessRequestLink(tag);

        default:
            return null;
    }
}
