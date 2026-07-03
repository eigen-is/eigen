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

import * as path from 'node:path';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
} from '@workspace/lib/types/calendar';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import type { SSEvent } from '@workspace/lib/types/sse';
import type {
    CreateEventArgs,
    InvitationUpdatePayload,
    ReceiveInvitationPayload,
    UpdateEventArgs,
} from '../calendar/types';
import { getAvatarsDir } from '../config/paths';
import type { PersistInput } from '../notification-center/notification-center';
import type { User } from '../user';
import { updateUser } from '../user/';
import { atHome, getHome, getTeamHome } from './get-home';

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
            if (!home.hasCalendar) break;
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
            if (!home.hasCalendar) break;
            home.calendar.receiveInvitation(message.payload);
            break;
        case 'calendar:invitation-update':
            if (!home.hasCalendar) break;
            home.calendar.receiveInvitationUpdate(message.orgEventId, message.orgUserId, message.payload);
            break;
        case 'calendar:invitation-removal':
            if (!home.hasCalendar) break;
            home.calendar.removeInvitation(message.orgEventId, message.orgUserId);
            break;
        case 'calendar:rsvp':
            if (!home.hasCalendar) break;
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

// --- Calendar event seam (reads + writes on another user's calendar) ---
// Every read/write on a foreign calendar routes through one of the five functions below.
// In a sharded deployment, only this module changes: getHome() becomes an RPC to the server
// hosting ownerUserId. The `user` argument is the actor (for SSE/audit), same-server today,
// serialized across the wire in a sharded future.

export async function pullEventsInRange(
    ownerUserId: string,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<CalendarEventOccurrence[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getEventsInRange(from, to, calendarId);
}

export async function pullCalendarById(ownerUserId: string, calendarId: string): Promise<CalendarItem | null> {
    const home = await getHome(ownerUserId);
    return home.calendar.getCalendarById(calendarId);
}

export async function createEventAt(
    ownerUserId: string,
    calendarId: string,
    input: CreateEventArgs,
    user: User,
): Promise<CalendarEvent> {
    const home = await getHome(ownerUserId);
    return home.calendar.createEvent(calendarId, input, user);
}

export async function updateEventAt(
    ownerUserId: string,
    calendarId: string,
    eventId: string,
    input: UpdateEventArgs,
    user: User,
): Promise<CalendarEvent> {
    const home = await getHome(ownerUserId);
    return home.calendar.updateEvent(calendarId, eventId, input, user);
}

export async function deleteEventAt(
    ownerUserId: string,
    calendarId: string,
    eventId: string,
    user: User,
): Promise<void> {
    const home = await getHome(ownerUserId);
    await home.calendar.deleteEvent(calendarId, eventId, user);
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

// Home → server seam: in a sharded deployment, this becomes an RPC to the central server.
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    const avatarPath = path.join(getAvatarsDir(), `${userId}.webp`);

    if (avatarWebP) {
        await Bun.write(avatarPath, avatarWebP);
    } else {
        await Bun.file(avatarPath)
            .delete()
            .catch(() => {});
    }

    await updateUser(userId, name, avatarWebP ? `server/avatars/${userId}.webp` : '');
}

export async function pullTeamQuotaOverrides(teamOwnerId: string): Promise<TeamQuotaOverrides> {
    const home = await getTeamHome(teamOwnerId);
    return home.settings.get().memberOverrides ?? {};
}

export async function pullTeamMounts(
    teamOwnerId: string,
): Promise<{ id: string; name: string; rootPathId: string | null }[]> {
    const home = await getTeamHome(teamOwnerId);
    const mounts = home.settings.get().mounts ?? {};
    const enabled = Object.entries(mounts).filter(([, m]) => m.enabled);
    return Promise.all(
        enabled.map(async ([id, m]) => {
            const root = await home.drive.getRootFolder(id);
            return { id, name: m.name || id, rootPathId: root?.id ?? null };
        }),
    );
}
