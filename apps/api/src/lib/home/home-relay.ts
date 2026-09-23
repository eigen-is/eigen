// The sharding seam: every touch of another user's Home goes through here, so a sharded deployment changes only this file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
} from '@workspace/lib/types/calendar';
import type { DriveACL, DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import { teamOwnerId } from '@workspace/lib/types/owner';
import type { HomeSizeResponse, TeamSettings, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { readCalendarTotalSize } from '../calendar/resource-store';
import type { CreateEventArgs, InvitationUpdatePayload, ReceiveInvitationPayload } from '../calendar/types';
import { getAvatarsDir, getUserHomePath } from '../config/paths';
import { resolveUserQuotas } from '../config/quota';
import { readContactsTotalSize } from '../contacts/card-store';
import { LocalFilesystem, PATHS } from '../core';
import type { EventPatch } from '../ical/ical-component';
import { readMailTotalSize } from '../mail/maildir-store';
import { createDefaultMountConfig, createMountConfig, readMountTotalSize } from '../mount/helpers';
import type { User } from '../user';
import { getMemberships, getUserByEmail, updateUser } from '../user';
import { atHome, getHome, getTeamHome } from './get-home';

export type HomeMessage =
    | { type: 'drive:acl-change'; path: DrivePath; acl: DriveACL[] | null; actorEmail?: string; actorName?: string }
    | {
          type: 'calendar:share';
          ownerId: string;
          calendarId: string;
          name: string;
          permission: CalendarShare['permission'] | null;
          actorEmail?: string;
          actorName?: string;
      }
    | { type: 'calendar:invitation'; payload: ReceiveInvitationPayload }
    | { type: 'calendar:invitation-update'; orgEventId: string; orgUserId: string; payload: InvitationUpdatePayload }
    | {
          type: 'calendar:invitation-removal';
          orgEventId: string;
          orgUserId: string;
          // Set when only ONE occurrence goes, with the revision the RFC 5546 ordering guard compares.
          occurrence?: { recurrenceDate: string; sequence: number; dtstamp: Date };
      }
    | {
          type: 'calendar:rsvp';
          eventId: string;
          attendeeEmail: string;
          status: Attendee['status'];
          recurrenceDate?: string;
      }
    | { type: 'broadcast'; event: SSEvent }
    | { type: 'notification'; notification: NotificationPersistInput };

export async function sendToHome(targetUserId: string, message: HomeMessage): Promise<void> {
    if (message.type === 'broadcast' && !atHome(targetUserId)) {
        return;
    }

    const home = await getHome(targetUserId);

    switch (message.type) {
        case 'drive:acl-change':
            await home.drive.receiveSharedPathChange(message.path, message.acl, message.actorEmail, message.actorName);
            break;
        case 'calendar:share':
            if (!home.hasCalendar) break;
            if (message.permission) {
                await home.calendar.receiveShare(
                    message.ownerId,
                    message.calendarId,
                    message.name,
                    message.permission,
                    message.actorEmail,
                    message.actorName,
                );
            } else {
                await home.calendar.removeShare(
                    message.ownerId,
                    message.calendarId,
                    message.actorEmail,
                    message.actorName,
                );
            }
            break;
        case 'calendar:invitation': {
            if (!home.hasCalendar) break;
            // A dropped invitation is logged: the organizer's side otherwise believes this Home holds a copy it refused.
            const received = await home.calendar.receiveInvitation(message.payload);
            if (!received) {
                console.info(
                    `home-relay: ${targetUserId} dropped the invitation ${message.payload.uid} from ${message.payload.organizerUserId}`,
                );
            }
            break;
        }
        case 'calendar:invitation-update':
            if (!home.hasCalendar) break;
            await home.calendar.receiveInvitationUpdate(message.orgEventId, message.orgUserId, message.payload);
            break;
        case 'calendar:invitation-removal':
            if (!home.hasCalendar) break;
            if (message.occurrence) {
                await home.calendar.cancelInvitationOccurrence(
                    message.orgEventId,
                    message.orgUserId,
                    message.occurrence.recurrenceDate,
                    null,
                    message.occurrence,
                );
            } else {
                await home.calendar.removeInvitation(message.orgEventId, message.orgUserId);
            }
            break;
        case 'calendar:rsvp':
            if (!home.hasCalendar) break;
            if (message.recurrenceDate) {
                // PARTSTAT only: an RSVP never resurrects an occurrence the organizer deleted.
                await home.calendar.receiveRsvpForOccurrence(
                    message.eventId,
                    message.attendeeEmail,
                    message.status,
                    message.recurrenceDate,
                    null,
                    false,
                );
            } else {
                await home.calendar.receiveAttendeeStatus(message.eventId, message.attendeeEmail, message.status);
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

// One fan-out for the chat and drive broadcasters, so their null-guard and catch behavior cannot drift apart.
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

export async function pullSharedPaths(ownerUserId: string, user: User): Promise<DrivePath[]> {
    const home = await getHome(ownerUserId);
    return home.drive.getSharedWith(user);
}

export async function pullDrivePath(ownerUserId: string, mountId: string, pathId: string): Promise<DrivePath | null> {
    const home = await getHome(ownerUserId);
    return home.drive.getPath(mountId, pathId);
}

// Reads the home's own files instead of booting the Home: the admin Users page sizes every user at once, and a boot apiece costs seconds.
export async function pullHomeSize(ownerUserId: string): Promise<HomeSizeResponse> {
    // Sizing reads a user home's folder layout and quotas; a team or org home has neither.
    if (ownerUserId.startsWith('team_') || ownerUserId.startsWith('org_')) {
        throw new Error(`pullHomeSize expects a user owner id, got ${ownerUserId}`);
    }
    const homeDir = getUserHomePath(ownerUserId);
    // A user who has never signed in has no home folder yet, and sizing must not create one.
    const homeFs = fs.existsSync(homeDir) ? new LocalFilesystem(homeDir) : null;
    const [contacts, mail, calendars] = await Promise.all([
        homeFs ? readContactsTotalSize(homeFs) : 0,
        homeFs ? readMailTotalSize(homeFs) : 0,
        homeFs ? readCalendarTotalSize(homeFs) : 0,
    ]);
    const driveUsed = readMountTotalSize(
        path.join(homeDir, PATHS.DRIVE.ROOT, PATHS.DRIVE.DEFAULT_MOUNT, PATHS.DRIVE.METADATA_DB),
    );

    const settingsFile = Bun.file(path.join(homeDir, PATHS.SETTINGS));
    const settings: UserSettings = (await settingsFile.exists()) ? await settingsFile.json() : {};
    const mountSettings = settings.mounts?.[PATHS.DRIVE.DEFAULT_MOUNT];
    const { teamIds } = await getMemberships(ownerUserId);
    const quotas = await resolveUserQuotas(
        mountSettings ? createMountConfig(PATHS.DRIVE.DEFAULT_MOUNT, mountSettings) : createDefaultMountConfig(),
        teamIds,
    );

    const dataUsed = contacts + mail + calendars;
    return {
        homeData: { used: dataUsed, max: quotas.homeDataMax },
        drive: { default: { used: driveUsed, max: quotas.mountMax } },
        total: { used: dataUsed + driveUsed, max: quotas.homeDataMax + quotas.mountMax },
    };
}

export async function pullCalendarShares(
    ownerUserId: string,
    email: string,
    teamIds: string[],
): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getSharedWith(email, teamIds);
}

// The `user` argument below is the acting user, for SSE and audit, not the owner of the calendar.

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

export async function pullEventById(
    ownerUserId: string,
    calendarId: string,
    eventId: string,
): Promise<CalendarEvent | null> {
    const home = await getHome(ownerUserId);
    return home.calendar.getEventById(calendarId, eventId);
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
    input: EventPatch,
    user: User,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const home = await getHome(ownerUserId);
    return home.calendar.updateEvent(calendarId, eventId, input, user, expectedEtag);
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

export async function moveEventAt(
    ownerUserId: string,
    calendarId: string,
    eventId: string,
    targetCalendarId: string,
): Promise<CalendarEvent> {
    const home = await getHome(ownerUserId);
    return home.calendar.moveEvent(calendarId, eventId, targetCalendarId);
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

export type TeamQuotaOverrides = NonNullable<TeamSettings['memberOverrides']>;

async function writeAvatar(ownerId: string, avatarWebP: Buffer | null): Promise<void> {
    const avatarPath = path.join(getAvatarsDir(), `${ownerId}.webp`);

    if (avatarWebP) {
        await Bun.write(avatarPath, avatarWebP);
    } else {
        await Bun.file(avatarPath)
            .delete()
            .catch(() => {});
    }
}

// Home → server seam: in a sharded deployment, this becomes an RPC to the central server.
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(userId, avatarWebP);
    await updateUser(userId, name, avatarWebP ? `server/avatars/${userId}.webp` : '');
}

// Team avatars have no auth-schema row to update (unlike pushUserProfile) — the file is the truth.
export async function pushTeamAvatar(teamId: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(teamOwnerId(teamId), avatarWebP);
}

export async function pullTeamQuotaOverrides(ownerId: string): Promise<TeamQuotaOverrides> {
    const home = await getTeamHome(ownerId);
    return home.settings.get().memberOverrides ?? {};
}

export async function pullTeamMounts(
    ownerId: string,
): Promise<{ id: string; name: string; rootPathId: string | null }[]> {
    const home = await getTeamHome(ownerId);
    const mounts = home.settings.get().mounts ?? {};
    const enabled = Object.entries(mounts).filter(([, m]) => m.enabled);
    return Promise.all(
        enabled.map(async ([id, m]) => {
            const root = await home.drive.getRootFolder(id);
            return { id, name: m.name || id, rootPathId: root?.id ?? null };
        }),
    );
}

// Team membership grants read of the whole mount by design, so the caller-side membership check is the only gate.
export async function pullMimeContents(ownerId: string, mimeType: string): Promise<DrivePath[]> {
    const home = await getTeamHome(ownerId);
    return home.drive.getMimeTypeContents(mimeType);
}

// Same gate as pullMimeContents: team membership grants read of the whole mount.
export async function pullDriveSearch(ownerId: string, opts: { q: string; limit: number }): Promise<DrivePath[]> {
    const home = await getTeamHome(ownerId);
    return home.drive.search(opts);
}
