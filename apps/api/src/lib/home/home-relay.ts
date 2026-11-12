// Every time one owner's Home reaches into another, it goes through this file. sendToHome pushes a message into
// another home, each pull reads one answer from one, such as the paths shared with a user, and pullFromEach runs a
// pull against many homes at once. A few calls write server-wide data instead, such as a user's avatar. Today every
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
import type { HomeSizeResponse, MyTeam, TeamSettings, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { settlesWithin } from '../../utils/timing';
import { captureBytes, snapshotHome } from '../backup/snapshot-home';
import type { Calendar } from '../calendar/calendar';
import { readCalendarTotalSize } from '../calendar/resource-store';
import type { CreateEventArgs, InvitationRequest } from '../calendar/types';
import {
    getAvatarsDir,
    getDataRoot,
    getUserHomePath,
    homeDirUnder,
    PATHS,
    SERVER_DIR,
    SERVER_FILES,
} from '../config/paths';
import { readContactsTotalSize } from '../contacts/card-store';
import { LocalFilesystem } from '../core';
import type { VisiblePath } from '../drive/drive';
import type { EventPatch } from '../ical/ical-component';
import { readMailTotalSize } from '../mail/maildir-store';
import type { Memberships, User } from '../user';
import { getMemberships, getOwnerExists, getUserById, getUsersByEmails, isGuest, updateUser } from '../user';
import { getHome, getTeamHome, loadedHome, openHome } from './get-home';
import { homeSize, userHomeSize } from './home';
import { TeamHome } from './team-home';

// --- Pushes ---

// A message is plain data, so that it can later travel to a home in another process. The target
// home does the whole job itself, its events and notifications included.
type HomeMessage =
    | { type: 'drive:acl-change'; path: DrivePath; acl: DriveACL[] | null; actorEmail?: string; actorName?: string }
    | { type: 'drive:recent-open'; ownerId: string; mountId: string; pathId: string }
    | {
          type: 'calendar:share';
          ownerId: string;
          calendarId: string;
          name: string;
          permission: CalendarShare['permission'] | null;
          actorEmail?: string;
          actorName?: string;
      }
    | ({ type: 'calendar:request' } & InvitationRequest)
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

// A broadcast opens no home, so it never becomes a delivery.
type DeliveredMessage = Exclude<HomeMessage, { type: 'broadcast' }>;

// Every push still delivering. Most of them run after their request answered, so nobody waits for them. A delivery
// opens its recipient's home, so a shutdown drains them first.
const deliveries = new Set<Promise<void>>();

// The last fan-out queued for each order key. The next one waits for it: an add and a revoke delivered out of order
// would bring a removed share back.
const lastInOrder = new Map<string, Promise<void>>();

export async function sendToHome(targetId: string, message: HomeMessage): Promise<void> {
    // A broadcast only reaches tabs that have the home open. It never opens a home or keeps one open.
    if (message.type === 'broadcast') {
        loadedHome(targetId)?.broadcast(message.event);
        return;
    }
    await tracked(deliver(targetId, message));
}

async function deliver(targetId: string, message: DeliveredMessage): Promise<void> {
    const home = await getHome(targetId);
    // A home without a calendar, such as a guest's, ignores every calendar message.
    if (message.type.startsWith('calendar:') && !home.hasCalendar) return;

    switch (message.type) {
        case 'drive:acl-change':
            await home.drive.receiveSharedPathChange(message.path, message.acl, message.actorEmail, message.actorName);
            break;
        case 'drive:recent-open':
            home.drive.touchRecent(message.ownerId, message.mountId, message.pathId);
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
        case 'calendar:request':
            await home.calendar.receiveRequest(message.events, message.link);
            break;
        case 'calendar:invitation-removal':
            if (message.occurrence) {
                await home.calendar.cancelInvitationOccurrence(message.orgEventId, message.orgUserId, {
                    ...message.occurrence,
                    recurrenceId: null,
                });
            } else {
                await home.calendar.removeInvitation(message.orgEventId, message.orgUserId);
            }
            break;
        case 'calendar:rsvp':
            if (message.recurrenceDate) {
                await home.calendar.receiveRsvpForOccurrence(message.eventId, message.attendeeEmail, message.status, {
                    recurrenceDate: message.recurrenceDate,
                    recurrenceId: null,
                });
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
                home.notify(message.notification);
            }
            break;
    }
}

// One home at a time, since opening a home blocks the event loop: opened together, they would freeze the server for the
// whole fan-out. A failed delivery is logged, and the other homes still get the message, so this never rejects.
export async function sendToUserHomes(userIds: Iterable<string>, message: DeliveredMessage): Promise<void> {
    const orderKey = message.type === 'drive:acl-change' ? message.path.id : undefined;
    const previous = orderKey ? lastInOrder.get(orderKey) : undefined;
    const fanOut = tracked(deliverToEach(userIds, message, previous));
    if (orderKey) lastInOrder.set(orderKey, fanOut);
    await fanOut;
    if (orderKey && lastInOrder.get(orderKey) === fanOut) lastInOrder.delete(orderKey);
}

async function deliverToEach(
    userIds: Iterable<string>,
    message: DeliveredMessage,
    previous: Promise<void> | undefined,
): Promise<void> {
    await previous;
    for (const id of userIds) {
        await deliver(id, message).catch((err) =>
            console.error(`home-relay: delivering ${message.type} to ${id} failed:`, err),
        );
    }
}

function tracked(delivery: Promise<void>): Promise<void> {
    deliveries.add(delivery);
    return delivery.finally(() => deliveries.delete(delivery));
}

// Waits for every delivery still running and for those that start meanwhile. The sends of a caller's own loop that
// hasn't reached them yet are not among them.
export async function drainHomeDeliveries(): Promise<void> {
    while (deliveries.size > 0) {
        await Promise.allSettled([...deliveries]);
    }
}

// A delivery can hang on a home that is slow to close, such as during a bucket outage. It must not hang a shutdown, or
// use up the time the mounts need to upload. What is left when the bound is over is lost, as in a crash.
export async function drainDeliveriesWithin(boundMs: number): Promise<void> {
    if (await settlesWithin(drainHomeDeliveries(), boundMs)) return;
    console.warn(`[shutdown] gave up after ${boundMs} ms with ${deliveries.size} home deliveries left`);
}

// Tells the open tabs of the owner and of each member who can read the path: a member without read cannot list it, so
// the event would name a path they may not see. Members come in one query; a failed read costs only their copies.
export async function broadcastToOwnerAndMembers(
    ownerId: string,
    members: EffectiveMember[] | Promise<EffectiveMember[]>,
    event: SSEvent,
): Promise<void> {
    await sendToHome(ownerId, { type: 'broadcast', event });
    let readers: User[];
    try {
        const emails = (await members).filter((member) => member.read).map((member) => member.email);
        readers = await getUsersByEmails([...new Set(emails)]);
    } catch {
        return;
    }
    await Promise.all(
        readers.filter((user) => user.id !== ownerId).map((user) => sendToHome(user.id, { type: 'broadcast', event })),
    );
}

// --- Reads across homes ---

// A gone owner is skipped, and a failed read is logged and leaves that owner out, so the others still answer.
export async function pullFromEach<T>(
    ownerIds: readonly string[],
    pull: (ownerId: string) => Promise<T>,
): Promise<T[]> {
    const results = await Promise.all(
        ownerIds.map((ownerId) =>
            getOwnerExists(ownerId)
                .then((exists) => (exists ? pull(ownerId) : null))
                .catch((err) => {
                    console.error(`home-relay: reading ${ownerId} failed:`, err);
                    return null;
                }),
        ),
    );
    return results.filter((result) => result !== null);
}

// --- Drive ---

export async function pullSharedPaths(ownerId: string, user: User): Promise<DrivePath[]> {
    const home = await getHome(ownerId);
    return home.drive.getAllSharedWith(user);
}

export async function pullDrivePath(ownerId: string, mountId: string, pathId: string): Promise<DrivePath | null> {
    const home = await getHome(ownerId);
    return home.drive.getPath(mountId, pathId);
}

// The paths a user's own rows name, such as those of Recent, as far as the user may still see them: one read per
// owner, who answers from the path as it is now.
export async function pullVisiblePaths<Row extends { ownerId: string; mountId: string; pathId: string }>(
    user: User,
    memberships: Memberships,
    rows: readonly Row[],
    mimeTypePrefix = '',
): Promise<VisiblePath<Row>[]> {
    const byOwner = Map.groupBy(rows, (row) => row.ownerId);
    const lists = await pullFromEach([...byOwner.keys()], async (ownerId) => {
        const home = await getHome(ownerId);
        return home.drive.getVisiblePaths(user, memberships, byOwner.get(ownerId) ?? [], mimeTypePrefix);
    });
    return lists.flat();
}

// --- Calendar ---

// The calendar of a home that has one. Every other owner answers as if the caller may not see the calendar, so asking
// never creates a home, and the answer doesn't tell which owners exist.
async function calendarOf(ownerId: string): Promise<Calendar | null> {
    if (!fs.existsSync(homeDirUnder(getDataRoot(), ownerId))) return null;
    const home = await getHome(ownerId);
    return home.hasCalendar ? home.calendar : null;
}

export async function pullCalendars(ownerId: string): Promise<CalendarItem[]> {
    return (await calendarOf(ownerId))?.getCalendars() ?? [];
}

export async function pullCalendarById(ownerId: string, calendarId: string): Promise<CalendarItem | null> {
    const home = await getHome(ownerId);
    return home.calendar.getCalendarById(calendarId);
}

export async function pullCalendarPermission(
    ownerId: string,
    calendarId: string,
    email: string,
    teamIds: string[],
): Promise<CalendarShare['permission'] | null> {
    return (await calendarOf(ownerId))?.checkPermission(calendarId, email, teamIds) ?? null;
}

export async function pullCalendarShares(
    ownerId: string,
    email: string,
    teamIds: string[],
): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> {
    return (await calendarOf(ownerId))?.getSharedWith(email, teamIds) ?? [];
}

export async function pullEventsInRange(
    ownerId: string,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<CalendarEventOccurrence[]> {
    const home = await getHome(ownerId);
    return home.calendar.getEventsInRange(from, to, calendarId);
}

export async function pullEventById(
    ownerId: string,
    calendarId: string,
    eventId: string,
): Promise<CalendarEvent | null> {
    const home = await getHome(ownerId);
    return home.calendar.getEventById(calendarId, eventId);
}

export async function pullPendingInvitations(ownerId: string, attendeeEmail: string): Promise<InvitationRequest[]> {
    return (await calendarOf(ownerId))?.pendingInvitations(attendeeEmail) ?? [];
}

// In the event writes, `user` is the person who makes the change, not the owner of the calendar.
// The owner's home uses it for the live updates it sends and for the history it keeps.

export async function createEventAt(
    ownerId: string,
    calendarId: string,
    input: CreateEventArgs,
    user: User,
): Promise<CalendarEvent> {
    const home = await getHome(ownerId);
    return home.calendar.createEvent(calendarId, input, user);
}

export async function updateEventAt(
    ownerId: string,
    calendarId: string,
    eventId: string,
    input: EventPatch,
    user: User,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const home = await getHome(ownerId);
    return home.calendar.updateEvent(calendarId, eventId, input, user, expectedEtag);
}

export async function deleteEventAt(
    ownerId: string,
    calendarId: string,
    eventId: string,
    user: User,
    expectedEtag?: string,
): Promise<void> {
    const home = await getHome(ownerId);
    await home.calendar.deleteEvent(calendarId, eventId, user, expectedEtag);
}

export async function moveEventAt(
    ownerId: string,
    calendarId: string,
    eventId: string,
    targetCalendarId: string,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const home = await getHome(ownerId);
    return home.calendar.moveEvent(calendarId, eventId, targetCalendarId, expectedEtag);
}

// --- Teams ---

export type TeamQuotaOverrides = NonNullable<TeamSettings['memberOverrides']>;

export async function pullTeamQuotaOverrides(ownerId: string): Promise<TeamQuotaOverrides> {
    const home = await getTeamHome(ownerId);
    return home.settings.get().memberOverrides ?? {};
}

export async function pullTeamMounts(ownerId: string): Promise<MyTeam['mounts']> {
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
    const settingsFile = Bun.file(path.join(homeDir, PATHS.SETTINGS));
    const settings: UserSettings = (await settingsFile.exists()) ? await settingsFile.json() : {};
    const { teamIds } = await getMemberships(ownerUserId);
    return userHomeSize(homeDir, settings, contacts + mail + calendars, teamIds);
}

// Opened without counting as a request, so a nightly backup keeps open only the homes somebody uses. It never closes
// the home, which a user may have opened during the capture, and a home that closed meanwhile fails the capture.
export async function pullHomeSnapshot(
    ownerId: string,
    targetDir: string,
    options: { level?: BackupLevel; onProgress?: BackupProgress },
): Promise<BackupManifest> {
    const home = await openHome(ownerId);
    const manifest = await home.withHomeHeld(() => snapshotHome(home, targetDir, options));
    if (home.closing) throw new Error('the home closed during the capture');
    return manifest;
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
