// Every time one owner's Home reaches into another, it goes through this file. sendToHome pushes a message into
// another home. getFromHomes asks many homes one question, such as which paths a user watches there, and the domain
// that owns the question keeps its handler. It opens at most a few homes at once and leaves out a home that is too
// slow. The other reads, each pull and pullFromEach, open their homes with no such limit. Today every call runs in
// this process. When homes live in several processes, only this file has to change.

import * as fs from 'node:fs';
import type { Attendee, CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACL, EffectiveMember } from '@workspace/lib/types/drive-access';
import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import type { MyTeam, TeamSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { Semaphore } from '../../utils/semaphore';
import { settlesWithin } from '../../utils/timing';
import type { Calendar } from '../calendar/calendar';
import type { InvitationRequest } from '../calendar/types';
import { getDataRoot, homeDirUnder } from '../config/paths';
import { ApiError } from '../core';
import type { VisiblePath } from '../drive/drive';
import type { DriveQueries } from '../drive/home-calls';
import { answerDrive } from '../drive/home-calls';
import type { Memberships, User } from '../user';
import { getOwnerExists, getUsersByEmails } from '../user';
import { getHome, getTeamHome, loadedHome } from './get-home';
import type { Home } from './home';
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

// A domain's table of questions: for each kind, the handler that answers it on the Home that was asked.
export type Answerers<Q extends { [K in keyof Q]: { ask: unknown; answer: unknown } }> = {
    [K in keyof Q]: (home: Home, ask: Q[K]['ask']) => Promise<Q[K]['answer']>;
};

type HomeQueries = DriveQueries;

const answerers: Answerers<HomeQueries> = { ...answerDrive };

export const HOME_OPENS_AT_ONCE = 4;

// Covers the wait for a slot and the open itself.
export const HOME_OPEN_DEADLINE_MS = 4000;

const opens = new Semaphore(HOME_OPENS_AT_ONCE);

// The capped opens still running. Every caller of one owner waits for the same open, so a home that hangs takes one
// slot however many ask for it.
const opening = new Map<string, Promise<Home>>();

// A gone owner is skipped. A home that fails, or that doesn't open within the deadline, is logged and left out, so the
// others still answer and this never rejects.
export async function getFromHomes<K extends keyof HomeQueries>(
    ownerIds: readonly string[],
    kind: K,
    ask: HomeQueries[K]['ask'],
): Promise<Map<string, HomeQueries[K]['answer']>> {
    const answers = new Map<string, HomeQueries[K]['answer']>();
    await Promise.all(
        ownerIds.map(async (ownerId) => {
            try {
                if (!(await getOwnerExists(ownerId))) return;
                const home = await openUnderCap(ownerId);
                answers.set(ownerId, await answerers[kind](home, ask));
            } catch (err) {
                console.error(`home-relay: ${kind} from ${ownerId} failed:`, err);
            }
        }),
    );
    return answers;
}

// A loaded home skips the queue, so a read of it never waits behind homes that are opening. The deadline only ends
// this caller's wait: an open cannot be cancelled, so it keeps its slot until it settles.
async function openUnderCap(ownerId: string): Promise<Home> {
    const home = loadedHome(ownerId) ? getHome(ownerId) : cappedOpen(ownerId);
    if (await settlesWithin(home, HOME_OPEN_DEADLINE_MS)) return home;
    throw new ApiError(503, `Home ${ownerId} did not open within ${HOME_OPEN_DEADLINE_MS} ms`);
}

function cappedOpen(ownerId: string): Promise<Home> {
    let open = opening.get(ownerId);
    if (!open) {
        open = opens.run(() => getHome(ownerId)).finally(() => opening.delete(ownerId));
        opening.set(ownerId, open);
    }
    return open;
}

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

export async function pullPendingInvitations(ownerId: string, attendeeEmail: string): Promise<InvitationRequest[]> {
    return (await calendarOf(ownerId))?.pendingInvitations(attendeeEmail) ?? [];
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
