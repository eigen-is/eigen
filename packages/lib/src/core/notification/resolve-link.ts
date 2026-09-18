import {
    driveApi,
    getCalendarAppUrl,
    getDriveAppUrl,
    getDriveItemUrl,
    getDriveShareUrl,
    getMailAppUrl,
} from '@workspace/lib/api';
import { getMonthRange } from '@workspace/lib/calendar';
import { isChatType, isCollabType } from '@workspace/lib/types/drive';
import type { ChatNotificationThread, Notification } from '@workspace/lib/types/notification';
import { CHAT_NOTIFICATION_TYPES, parseChatNotificationThread } from './tags';

// share:{ownerId}:{mountId}:{pathId}
function parseShareTag(tag: string): ChatNotificationThread | null {
    const [kind, ownerId, mountId, pathId] = tag.split(':');
    if (kind !== 'share' || !ownerId || !mountId || !pathId) return null;
    return { ownerId, mountId, pathId };
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

function parseFileEventTag(tag: string): { ownerId: string; mountId: string; pathId: string } | null {
    const parts = tag.split(':');
    if (parts[0] !== 'file-event' || !parts[1] || !parts[2] || !parts[3]) return null;
    return { ownerId: parts[1], mountId: parts[2], pathId: parts[3] };
}

async function resolveDriveLink(parsed: ChatNotificationThread | null): Promise<string> {
    if (!parsed) return getDriveAppUrl();

    const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
        .path({ pathId: parsed.pathId })
        .get();
    if (response.error || !response.data) return getDriveAppUrl();

    const path = response.data;
    return getDriveItemUrl(path, { chat: parsed.chatName }) ?? getDriveShareUrl(path);
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
        ...CHAT_NOTIFICATION_TYPES,
        'share',
        'calendar-share',
        'calendar-unshare',
        'calendar-invite',
        'calendar-invite-updated',
        'calendar-invite-cancelled',
        'mail',
        'access-request',
        'file-event',
    ].includes(type);
}

export async function resolveNotificationLink(
    notification: Pick<Notification, 'type' | 'tag' | 'details'>,
): Promise<string | null> {
    const { type, tag, details } = notification;
    if (!tag) return null;

    if (CHAT_NOTIFICATION_TYPES.some((t) => t === type))
        return resolveDriveLink(parseChatNotificationThread(type, tag));

    switch (type) {
        case 'share':
            return resolveDriveLink(parseShareTag(tag));

        case 'calendar-invite':
        case 'calendar-invite-updated':
        case 'calendar-invite-cancelled': {
            const parsed = parseCalendarInviteTag(tag);
            if (parsed?.startTime) {
                const { from, to } = getMonthRange(new Date(parsed.startTime));
                return getCalendarAppUrl(`view/month/${from}/${to}?eventId=${encodeURIComponent(parsed.eventId)}`);
            }
            return getCalendarAppUrl();
        }

        case 'calendar-share':
        case 'calendar-unshare':
            return getCalendarAppUrl();

        case 'mail': {
            const mailId = details && 'mailId' in details ? details.mailId : undefined;
            return getMailAppUrl(mailId ? `box/inbox?mailId=${encodeURIComponent(mailId)}` : 'box/inbox');
        }

        case 'access-request':
            return resolveAccessRequestLink(tag);

        case 'file-event': {
            const parsed = parseFileEventTag(tag);
            if (!parsed) return getDriveAppUrl();
            const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
                .path({ pathId: parsed.pathId })
                .get();
            if (response.error || !response.data) return getDriveAppUrl();
            const path = response.data;
            // Only collab/chat types navigate directly into their app; plain files and folders
            // land on the fs view with the item selected.
            if (isCollabType(path.type) || isChatType(path.type)) {
                const cardId = details && 'cardId' in details ? details.cardId : undefined;
                const chatName = details && 'chatName' in details ? details.chatName : undefined;
                const itemUrl = getDriveItemUrl(path, { card: cardId, chat: chatName });
                if (itemUrl) return itemUrl;
            }
            return getDriveAppUrl(`fs/${parsed.ownerId}/${parsed.mountId}/${path.parentId ?? path.id}?pid=${path.id}`);
        }

        default:
            return null;
    }
}
