// Every time one owner's Home reaches into another, it goes through this file. sendToHome pushes a
// message into another home, and each pull reads one answer from one, such as the paths shared
// with a user. A few calls write server-wide data instead, such as a user's avatar. Today every
// call runs in this process. When homes live in several processes, only this file has to change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupLevel, BackupManifest, BackupProgress } from '@workspace/lib/types/backup';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
} from '@workspace/lib/types/calendar';
import type { DriveACL, DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types/owner';
import type { HomeSizeResponse, TeamSettings, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { Semaphore } from '../../utils/semaphore';
import { captureBytes, snapshotHome } from '../backup/snapshot-home';
import type { Calendar } from '../calendar/calendar';
import { readCalendarTotalSize } from '../calendar/resource-store';
import type { CreateEventArgs, InvitationUpdatePayload, ReceiveInvitationPayload } from '../calendar/types';
import {
    getAvatarsDir,
    getDataRoot,
    getUserHomePath,
    homeDirUnder,
    PATHS,
    SERVER_DIR,
    SERVER_FILES,
} from '../config/paths';
import { resolveUserQuotas } from '../config/quota';
import { readContactsTotalSize } from '../contacts/card-store';
import { LocalFilesystem } from '../core';
import type { EventPatch } from '../ical/ical-component';
import { readMailTotalSize } from '../mail/maildir-store';
import { createDefaultMountConfig, createMountConfig, readMountTotalSize } from '../mount/helpers';
import type { User } from '../user';
import { getMemberships, getUserById, getUsersByEmails, isGuest, updateUser } from '../user';
import { getHome, getTeamHome, loadedHome, openHome, requestedSince } from './get-home';
import { homeSize } from './home';
import { TeamHome } from './team-home';

// --- Pushes ---

// A message is plain data, so that it can later travel to a home in another process. The target
// home does the whole job itself, its events and notifications included.
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
          // Set when only one occurrence is cancelled. Its revision lets the attendee's home ignore a
          // cancellation that is older than the copy it holds.
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
    // A broadcast only reaches tabs that have the home open. It never opens a home or keeps one open.
    if (message.type === 'broadcast') {
        loadedHome(targetUserId)?.broadcast(message.event);
        return;
    }

    const home = await getHome(targetUserId);
    // A home without a calendar, such as a guest's, ignores every calendar message.
    if (message.type.startsWith('calendar:') && !home.hasCalendar) return;

    switch (message.type) {
        case 'drive:acl-change':
            await home.drive.receiveSharedPathChange(message.path, message.acl, message.actorEmail, message.actorName);
            break;
        case 'calendar:share':
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
            const received = await home.calendar.receiveInvitation(message.payload);
            // The organizer's home believes this home holds a copy, so a refused invitation is logged.
            if (!received) {
                console.info(
                    `home-relay: ${targetUserId} dropped the invitation ${message.payload.uid} from ${message.payload.organizerUserId}`,
                );
            }
            break;
        }
        case 'calendar:invitation-update':
            await home.calendar.receiveInvitationUpdate(message.orgEventId, message.orgUserId, message.payload);
            break;
        case 'calendar:invitation-removal':
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
            if (message.recurrenceDate) {
                // An answer from an attendee only sets their status. It never brings back an occurrence
                // that the organizer deleted.
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
        case 'notification':
            if (home instanceof TeamHome) {
                const members = await home.membersToNotify(message.notification.actorEmail);
                await sendToUserHomes(
                    members.map((member) => member.id),
                    message,
                );
            } else {
                home.notifications?.persist(message.notification);
            }
            break;
    }
}

// Opening a home costs about 25 to 30 file descriptors and a burst of database opens. So the
// fan-outs through sendToUserHomes open at most eight homes at once, all of them together. An opened
// home still stays open for its idle time afterwards. Only deliveries to user homes take a permit,
// and a user home relays no further. So a delivery never waits for a permit that its own fan-out holds.
const deliveryBudget = new Semaphore(8);

// The fan-outs that are still delivering. Most of them run after their request answered, so nobody
// waits for them. A delivery opens its recipient's home, so a shutdown drains them first.
const deliveries = new Set<Promise<unknown>>();

// A failed delivery is logged, and the other homes still get the message.
export async function sendToUserHomes(userIds: Iterable<string>, message: HomeMessage): Promise<void> {
    const delivery = Promise.all(
        [...userIds].map((id) =>
            deliveryBudget.run(() =>
                sendToHome(id, message).catch((err) =>
                    console.error(`home-relay: delivering ${message.type} to ${id} failed:`, err),
                ),
            ),
        ),
    );
    deliveries.add(delivery);
    try {
        await delivery;
    } finally {
        deliveries.delete(delivery);
    }
}

// Waits for every fan-out that is still delivering, and for the ones that start meanwhile, such as a
// team notification that a delivery passes on to the members. Graceful shutdown calls it before it
// closes the homes.
export async function drainHomeDeliveries(): Promise<void> {
    while (deliveries.size > 0) {
        await Promise.allSettled([...deliveries]);
    }
}

export function countHomeDeliveries(): number {
    return deliveries.size;
}

// Tells the open tabs of the owner and of each member about one event, such as everyone who can read a
// changed path. The owner hears it at once. The members may still be read, and a failed read costs only
// their copies. Only homes that are open receive it, so a closed home costs nothing.
export async function broadcastToOwnerAndMembers(
    ownerId: string,
    members: EffectiveMember[] | Promise<EffectiveMember[]>,
    event: SSEvent,
): Promise<void> {
    await sendToHome(ownerId, { type: 'broadcast', event });
    try {
        await relayEventToMembers(ownerId, await members, event);
    } catch {}
}

// Tells the open tabs of each member once, but for the owner, who heard it already. In a user's home the
// owner is one of the members. The members are looked up in one query, because a team can have many. A
// member without an account is skipped.
export async function relayEventToMembers(ownerId: string, members: EffectiveMember[], event: SSEvent): Promise<void> {
    const users = await getUsersByEmails([...new Set(members.map((member) => member.email))]);
    await Promise.all(
        users
            .filter((user) => user.id !== ownerId)
            .map((user) => sendToHome(user.id, { type: 'broadcast', event }).catch(() => {})),
    );
}

// --- Drive ---

export async function pullSharedPaths(ownerUserId: string, user: User): Promise<DrivePath[]> {
    const home = await getHome(ownerUserId);
    return home.drive.getSharedWith(user);
}

export async function pullDrivePath(ownerUserId: string, mountId: string, pathId: string): Promise<DrivePath | null> {
    const home = await getHome(ownerUserId);
    return home.drive.getPath(mountId, pathId);
}

// --- Calendar ---

// The calendar of a home that has one. A user who never signed in has no home folder yet, and a guest
// or an org has no calendar. Each of them answers as if the caller may not see the calendar. So asking
// never creates a home, and the answer doesn't tell which owners exist.
async function calendarOf(ownerId: string): Promise<Calendar | null> {
    if (!fs.existsSync(homeDirUnder(getDataRoot(), ownerId))) return null;
    const home = await getHome(ownerId);
    return home.hasCalendar ? home.calendar : null;
}

export async function pullCalendars(ownerUserId: string): Promise<CalendarItem[]> {
    return (await calendarOf(ownerUserId))?.getCalendars() ?? [];
}

export async function pullCalendarById(ownerUserId: string, calendarId: string): Promise<CalendarItem | null> {
    const home = await getHome(ownerUserId);
    return home.calendar.getCalendarById(calendarId);
}

export async function pullCalendarPermission(
    ownerUserId: string,
    calendarId: string,
    email: string,
    teamIds: string[],
): Promise<CalendarShare['permission'] | null> {
    return (await calendarOf(ownerUserId))?.checkPermission(calendarId, email, teamIds) ?? null;
}

export async function pullCalendarShares(
    ownerUserId: string,
    email: string,
    teamIds: string[],
): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> {
    return (await calendarOf(ownerUserId))?.getSharedWith(email, teamIds) ?? [];
}

export async function pullEventsInRange(
    ownerUserId: string,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<CalendarEventOccurrence[]> {
    const home = await getHome(ownerUserId);
    return home.calendar.getEventsInRange(from, to, calendarId);
}

export async function pullEventById(
    ownerUserId: string,
    calendarId: string,
    eventId: string,
): Promise<CalendarEvent | null> {
    const home = await getHome(ownerUserId);
    return home.calendar.getEventById(calendarId, eventId);
}

export async function pullPendingInvitations(ownerUserId: string, attendeeEmail: string): Promise<CalendarEvent[]> {
    return (await calendarOf(ownerUserId))?.getEventsWithAttendee(attendeeEmail) ?? [];
}

// In the event writes, `user` is the person who makes the change, not the owner of the calendar.
// The owner's home uses it for the live updates it sends and for the history it keeps.

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

// --- Teams ---

export type TeamQuotaOverrides = NonNullable<TeamSettings['memberOverrides']>;

export async function pullTeamQuotaOverrides(ownerId: string): Promise<TeamQuotaOverrides> {
    const home = await getTeamHome(ownerId);
    return home.settings.get().memberOverrides ?? {};
}

export async function pullTeamMounts(
    ownerId: string,
): Promise<{ id: string; name: string; rootPathId: string | null }[]> {
    const home = await getTeamHome(ownerId);
    const mounts = Object.entries(home.settings.get().mounts ?? {}).filter(([, mount]) => mount.enabled);
    return Promise.all(
        mounts.map(async ([id, mount]) => {
            const root = await home.drive.getRootFolder(id);
            return { id, name: mount.name || id, rootPathId: root?.id ?? null };
        }),
    );
}

// The mail about a team notification goes to the same members that the notification reaches.
export async function pullTeamMembersToNotify(ownerId: string, actorEmail: string): Promise<User[]> {
    const home = await getTeamHome(ownerId);
    return home.membersToNotify(actorEmail);
}

// A team member may read the whole team drive, by design. So the caller's membership check is the
// only check, here and in pullDriveSearch.
export async function pullMimeContents(ownerId: string, mimeType: string): Promise<DrivePath[]> {
    const home = await getTeamHome(ownerId);
    return home.drive.getMimeTypeContents(mimeType);
}

export async function pullDriveSearch(ownerId: string, opts: { q: string; limit: number }): Promise<DrivePath[]> {
    const home = await getTeamHome(ownerId);
    return home.drive.search(opts);
}

// --- Size and backup ---

// Reads the home's files instead of opening the Home. The admin Users page sizes every user at once,
// and opening each home would take seconds.
export async function pullHomeSize(ownerUserId: string): Promise<HomeSizeResponse> {
    // Sizing reads the folders and quotas of a user home. Other homes, such as a team's, have neither.
    if (parseOwnerId(ownerUserId).type !== 'user') {
        throw new Error(`pullHomeSize expects a user owner id, got ${ownerUserId}`);
    }
    // A guest's home has no folders or quotas of its own, so it answers what the guest home answers.
    if (isGuest(await getUserById(ownerUserId))) return homeSize();
    const homeDir = getUserHomePath(ownerUserId);
    // A user who has never signed in has no home folder yet, and sizing must not create one.
    const homeFs = fs.existsSync(homeDir) ? new LocalFilesystem(homeDir) : null;
    const [contacts, mail, calendars] = homeFs
        ? await Promise.all([readContactsTotalSize(homeFs), readMailTotalSize(homeFs), readCalendarTotalSize(homeFs)])
        : [0, 0, 0];
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

    return homeSize(contacts + mail + calendars, driveUsed, quotas);
}

// How long a home that the backup opened for itself stays open after its capture. It is longer
// than the 15 s keepalives, so a user who opened the home in the meantime keeps it open.
export const BACKUP_RELEASE_MS = 30_000;

// A backup captures each home through here. A home that was closed is opened only for the capture,
// so a nightly backup does not leave every home open. It is never closed by force, because a user
// may have opened it during the capture.
export async function pullHomeSnapshot(
    ownerId: string,
    targetDir: string,
    options: { level?: BackupLevel; onProgress?: BackupProgress },
): Promise<BackupManifest> {
    const startedAt = Date.now();
    const wasOpen = loadedHome(ownerId) !== undefined;
    const home = await openHome(ownerId);
    // A capture can outlast the idle time while nobody is connected, for example on one big file at
    // night. The hold keeps the databases it reads open.
    const release = home.hold();
    try {
        return await snapshotHome(home, targetDir, options);
    } finally {
        release(!wasOpen && !requestedSince(home, startedAt) ? BACKUP_RELEASE_MS : undefined);
    }
}

// The server backup sizes every home through here before it starts, to check that there is room.
export async function pullHomeBackupBytes(ownerId: string, level: BackupLevel): Promise<number> {
    return captureBytes(homeDirUnder(getDataRoot(), ownerId), level);
}

// --- Server-wide data ---

// A user's name and avatar are server-wide data, not part of a home. When homes live in several
// processes, this becomes a call to the central server.
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(userId, avatarWebP);
    await updateUser(userId, name, avatarWebP ? `${SERVER_DIR}/${SERVER_FILES.avatars}/${userId}.webp` : '');
}

// A team has no row in the auth database to update, so its avatar file is all there is.
export async function pushTeamAvatar(teamId: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(teamOwnerId(teamId), avatarWebP);
}

async function writeAvatar(ownerId: string, avatarWebP: Buffer | null): Promise<void> {
    const avatarPath = path.join(getAvatarsDir(), `${ownerId}.webp`);
    if (avatarWebP) {
        await Bun.write(avatarPath, avatarWebP);
    } else {
        // There may be no avatar to delete.
        await Bun.file(avatarPath)
            .delete()
            .catch(() => {});
    }
}
