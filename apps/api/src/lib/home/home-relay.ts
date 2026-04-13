// Cross-home relay — the sharding seam.
//
// Every interaction where one user's action touches another user's Home
// flows through this module. Push operations (writes/notifications) use
// sendToHome() with a typed HomeMessage. Pull operations (reads) use
// individual pull*() functions.
//
// Today these are direct in-process calls via getHome(). In a sharded
// deployment, only this file changes: sendToHome() routes to the correct
// server (or enqueues a message), and pull functions become remote API calls.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attendee, CalendarEvent, CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import type { TeamSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import type { InvitationUpdatePayload, ReceiveInvitationPayload } from '../calendar/calendar';
import { getAvatarsDir } from '../config/paths';
import type { PersistInput } from '../notification-center/notification-center';
import { updateUser } from '../user/';
import { atHome, getHome } from './get-home';

export type HomeMessage =
    | { type: 'drive:acl-change'; path: DrivePath; acl: DriveACL[] | null; actorEmail?: string }
    | {
          type: 'calendar:share';
          ownerId: string;
          calendarId: string;
          name: string;
          color: string;
          permission: CalendarShare['permission'] | null;
          actorEmail?: string;
      }
    | { type: 'calendar:invitation'; payload: ReceiveInvitationPayload }
    | { type: 'calendar:invitation-update'; orgEventId: string; orgUserId: string; payload: InvitationUpdatePayload }
    | { type: 'calendar:invitation-removal'; orgEventId: string; orgUserId: string }
    | {
          type: 'calendar:rsvp';
          eventId: string;
          attendeeEmail: string;
          status: Attendee['status'];
          recurrenceDate?: string;
      }
    | { type: 'broadcast'; event: SSEvent }
    | { type: 'notification'; notification: PersistInput };

export async function sendToHome(targetUserId: string, message: HomeMessage): Promise<void> {
    if (message.type === 'broadcast' && !atHome(targetUserId)) {
        return;
    }

    const home = await getHome(targetUserId);

    switch (message.type) {
        case 'drive:acl-change':
            await home.drive.receiveACLChange(message.path, message.acl, message.actorEmail);
            break;
        case 'calendar:share':
            if (message.permission) {
                home.calendar.receiveShare(
                    message.ownerId,
                    message.calendarId,
                    message.name,
                    message.color,
                    message.permission,
                    message.actorEmail,
                );
            } else {
                home.calendar.removeShare(message.ownerId, message.calendarId, message.actorEmail);
            }
            break;
        case 'calendar:invitation':
            home.calendar.receiveInvitation(message.payload);
            break;
        case 'calendar:invitation-update':
            home.calendar.receiveInvitationUpdate(message.orgEventId, message.orgUserId, message.payload);
            break;
        case 'calendar:invitation-removal':
            home.calendar.removeInvitation(message.orgEventId, message.orgUserId);
            break;
        case 'calendar:rsvp':
            if (message.recurrenceDate) {
                home.calendar.rsvpForOccurrence(
                    message.eventId,
                    message.attendeeEmail,
                    message.status,
                    message.recurrenceDate,
                );
            } else {
                home.calendar.updateAttendeeStatus(message.eventId, message.attendeeEmail, message.status);
            }
            break;
        case 'broadcast':
            home.broadcast(message.event);
            break;
        case 'notification':
            home.notifications?.persist(message.notification);
            break;
    }
}

export async function pullSharedPaths(ownerUserId: string, user: User): Promise<DrivePath[]> {
    const home = await getHome(ownerUserId);
    return home.drive.getSharedWith(user);
}

export async function pullCalendarShares(
    ownerUserId: string,
    email: string,
    teamIds: string[],
): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getSharedWith(email, teamIds);
}

export async function pullPendingInvitations(ownerUserId: string, attendeeEmail: string): Promise<CalendarEvent[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getEventsWithAttendee(attendeeEmail);
}

export async function pullCalendarPermission(
    ownerUserId: string,
    calendarId: string,
    email: string,
    teamIds: string[],
): Promise<CalendarShare['permission'] | null> {
    const home = await getHome(ownerUserId);
    return home.calendar.checkPermission(calendarId, email, teamIds);
}

export async function pullCalendars(ownerUserId: string): Promise<CalendarItem[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getCalendars();
}

export type TeamQuotaOverrides = {
    mailAndContactsMaxMB?: number;
    defaultMountMaxSizeMB?: number;
};

/**
 * Home → server: sync public profile (name + avatar).
 * Today this is a direct in-process call. In a sharded deployment,
 * this becomes an RPC to the central server.
 */
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    const avatarPath = path.join(getAvatarsDir(), `${userId}.webp`);

    if (avatarWebP) {
        await Bun.write(avatarPath, avatarWebP);
    } else if (fs.existsSync(avatarPath)) {
        fs.unlinkSync(avatarPath);
    }

    await updateUser(userId, name, avatarWebP ? `server/avatars/${userId}.webp` : '');
}

export async function pullTeamQuotaOverrides(teamOwnerId: string): Promise<TeamQuotaOverrides> {
    const home = await getHome(teamOwnerId);
    const settings = home.settings.get() as TeamSettings;
    return settings.memberOverrides ?? {};
}

export async function pullTeamMounts(teamOwnerId: string): Promise<{ id: string; name: string }[]> {
    const home = await getHome(teamOwnerId);
    const settings = home.settings.get() as TeamSettings;
    const mounts = settings.mounts ?? {};
    return Object.entries(mounts)
        .filter(([, m]) => m.enabled)
        .map(([id, m]) => ({ id, name: m.name || id }));
}
