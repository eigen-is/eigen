import { driveApi, getCalendarAppUrl, getDocumentUrl, getDriveAppUrl, getMailAppUrl } from '@workspace/lib/api';
import { getMonthRange } from '@workspace/lib/calendar';
import type { Notification } from '@workspace/lib/types/notification';

function parseDriveTag(tag: string): { ownerId: string; mountId: string; pathId: string } | null {
    const [prefix, ownerId, mountId, pathId] = tag.split(':');
    if (!['share', 'mention'].includes(prefix) || !ownerId || !mountId || !pathId) return null;
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

async function resolveDriveLink(tag: string): Promise<string> {
    const parsed = parseDriveTag(tag);
    if (!parsed) return getDriveAppUrl();

    const response = await driveApi({ ownerId: parsed.ownerId })({ mountId: parsed.mountId })
        .path({ pathId: parsed.pathId })
        .get();
    if (response.error || !response.data) return getDriveAppUrl();

    return (
        getDocumentUrl(response.data) ||
        getDriveAppUrl(`fs/${response.data.ownerId}/${response.data.mountId}/${response.data.id}`)
    );
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
        'calendar-share',
        'calendar-unshare',
        'calendar-invite',
        'calendar-invite-updated',
        'calendar-invite-cancelled',
        'mail',
        'access-request',
    ].includes(type);
}

export async function resolveNotificationLink(notification: Notification, ownerId: string): Promise<string | null> {
    const { type, tag } = notification;
    if (!tag) return null;

    switch (type) {
        case 'share':
        case 'mention-chat':
        case 'mention-comment':
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
