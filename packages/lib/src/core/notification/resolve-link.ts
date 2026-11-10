// Turns a notification into the link its row opens, when the bell's row or a toast's View action is clicked. No URL
// is stored, so the link comes from the tag, and a Drive item is fetched at click time, so the link follows the item
// to the app its type opens in and survives a move.

import {
    driveApi,
    getCalendarAppUrl,
    getDriveAppUrl,
    getDriveItemUrl,
    getDriveShareUrl,
    getMailAppUrl,
} from '@workspace/lib/api';
import { getMonthRange } from '@workspace/lib/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isChatType, isCollabType } from '@workspace/lib/types/drive';
import type { ChatNotificationThread, Notification, NotificationPath } from '@workspace/lib/types/notification';
import {
    CHAT_NOTIFICATION_TYPES,
    parseAccessRequestTag,
    parseCalendarInviteTag,
    parseChatNotificationThread,
    parsePathTag,
} from './tags';

export function isClickableNotification(type: string): boolean {
    return [
        ...CHAT_NOTIFICATION_TYPES,
        'share',
        'calendar-share',
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
            return resolveDriveLink(parsePathTag('share', tag));

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
            return getCalendarAppUrl();

        case 'mail': {
            const mailId = details && 'mailId' in details ? details.mailId : undefined;
            return getMailAppUrl(mailId ? `box/inbox?mailId=${encodeURIComponent(mailId)}` : 'box/inbox');
        }

        case 'access-request': {
            const parsed = parseAccessRequestTag(tag);
            if (!parsed) return null;
            const path = await fetchDrivePath(parsed);
            if (!path) return null;
            return getDriveAppUrl(
                `fs/${parsed.ownerId}/${parsed.mountId}/${path.parentId ?? path.id}?sharePathId=${parsed.pathId}&shareEmail=${encodeURIComponent(parsed.email)}`,
            );
        }

        case 'file-event': {
            const parsed = parsePathTag('file-event', tag);
            if (!parsed) return getDriveAppUrl();
            const path = await fetchDrivePath(parsed);
            if (!path) return getDriveAppUrl();
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

async function resolveDriveLink(parsed: ChatNotificationThread | null): Promise<string> {
    if (!parsed) return getDriveAppUrl();
    const path = await fetchDrivePath(parsed);
    if (!path) return getDriveAppUrl();
    return getDriveShareUrl(path, { chat: parsed.chatName });
}

async function fetchDrivePath(path: NotificationPath): Promise<DrivePath | null> {
    const response = await driveApi({ ownerId: path.ownerId })({ mountId: path.mountId })
        .path({ pathId: path.pathId })
        .get();
    return response.error ? null : response.data;
}
