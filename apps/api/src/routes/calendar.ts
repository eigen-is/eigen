import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    FreeBusyBlock,
} from '@workspace/lib/types/calendar';
import { ICS_CONTENT_TYPE, isIcsFile } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { checkCalendarAccess, resolveCalendar, syncTeamCalendars } from '../lib/calendar/get-calendar';
import { ApiError, ICS_IMPORT_MAX_EVENTS, NOT_A_CALENDAR_FILE } from '../lib/core';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { contentDisposition, readBoundedBodyBytes } from '../lib/core/http';
import { readImportSourceBytes } from '../lib/drive';
import { getHome } from '../lib/home';
import {
    createEventAt,
    deleteEventAt,
    moveEventAt,
    pullCalendarById,
    pullCalendarShares,
    pullEventsInRange,
    updateEventAt,
} from '../lib/home/home-relay';
import { storedRecurrenceKey } from '../lib/ical/wall-clock';
import { getMemberships, type User } from '../lib/user';
import { betterAuth } from './auth';
import { importFromDriveSchema } from './shared-schemas';

const CalendarShareSchema = t.Object({
    targetId: t.String(),
    permission: t.Union([t.Literal('free-busy'), t.Literal('read'), t.Literal('write')]),
});

const CreateCalendarSchema = t.Object({
    name: t.String(),
    color: t.String(),
});

const UpdateCalendarSchema = t.Object({
    name: t.Optional(t.String()),
    color: t.Optional(t.String()),
    visible: t.Optional(t.Boolean()),
    shares: t.Optional(t.Nullable(t.Array(CalendarShareSchema))),
});

const ReminderSchema = t.Object({
    type: t.Union([t.Literal('notification'), t.Literal('email')]),
    minutes: t.Number(),
});

const AttendeeSchema = t.Object({
    email: t.String({ maxLength: MAX_EMAIL_LENGTH }),
    name: t.Optional(t.String()),
    status: t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
    role: t.Union([t.Literal('required'), t.Literal('optional')]),
});

const EventDataSchema = t.Object({
    reminders: t.Optional(t.Array(ReminderSchema)),
    attendees: t.Optional(t.Array(AttendeeSchema)),
    url: t.Optional(t.String()),
    color: t.Optional(t.String()),
});

// recurrenceDate is a wall-clock occurrence key (YYYY-MM-DD, docs/CALENDAR.md § Recurrence), but
// old FE builds sent the occurrence's full ISO datetime — normalize at the boundary and reject the
// unkeyable, so stored keys are always canonical.
function requireRecurrenceKey(value: string): string {
    const key = storedRecurrenceKey(value);
    if (!key) throw new ApiError(400, 'Invalid recurrenceDate');
    return key;
}

const CreateEventSchema = t.Object({
    title: t.String(),
    startTime: t.Date(),
    endTime: t.Date(),
    allDay: t.Boolean(),
    description: t.Optional(t.Nullable(t.String())),
    location: t.Optional(t.Nullable(t.String())),
    rrule: t.Optional(t.Nullable(t.String())),
    timezone: t.Optional(t.Nullable(t.String())),
    parentEventId: t.Optional(t.Nullable(t.String())),
    recurrenceDate: t.Optional(t.Nullable(t.String())),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const UpdateEventSchema = t.Object({
    title: t.Optional(t.String()),
    startTime: t.Optional(t.Date()),
    endTime: t.Optional(t.Date()),
    allDay: t.Optional(t.Boolean()),
    description: t.Optional(t.Nullable(t.String())),
    location: t.Optional(t.Nullable(t.String())),
    rrule: t.Optional(t.Nullable(t.String())),
    timezone: t.Optional(t.Nullable(t.String())),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const MoveEventSchema = t.Object({
    targetCalendarId: t.String(),
});

const UpdateSharedCalendarSchema = t.Object({
    color: t.Optional(t.Nullable(t.String())),
    visible: t.Optional(t.Boolean()),
});

// The calendar an import writes into, beside the Drive file it reads — the same source fields the
// contacts and mail import-from-drive routes take.
const ImportFromDriveIcsSchema = t.Object({
    ...importFromDriveSchema.properties,
    calendarId: t.String({ minLength: 1 }),
});

const ImportQuerySchema = t.Object({ calendarId: t.String({ minLength: 1 }) });

// The Home a transfer runs against, once the caller may read (an export) or write (an import) the calendar
// they named. A team home is the only Home here that is not the caller's own: any other owner is refused
// rather than resolved, because the file would be read out of that Home, or written into it, and only the
// relay crosses homes. Free-busy may learn when a calendar is busy, never what it says, so it is no read
// here either.
async function resolveTransferCalendar(user: User, ownerId: string, calendarId: string, need: 'read' | 'write') {
    if (parseOwnerId(ownerId).type !== 'team') requireSelf(ownerId, user.id);
    const { permission } = await checkCalendarAccess(user, ownerId, calendarId);
    if (permission === 'free-busy' || (need === 'write' && permission !== 'write')) {
        throw new ApiError(403, need === 'write' ? 'Write permission required' : 'Read permission required');
    }
    return resolveCalendar(user, ownerId);
}

// Calendar routes allow cross-owner access (shared calendars, team calendars).
// Access control is enforced by resolveCalendar() (own/team calendars) or
// checkCalendarAccess() (event-scoped, may include cross-user shared calendars).
// Cross-user reads/writes never touch the foreign Calendar instance directly —
// they go through the relay functions in `home-relay.ts` (the sharding seam).
export const calendarRouter = new Elysia({ name: 'calendar' })
    .use(betterAuth)

    // --- Calendars ---
    .get(
        '/calendar/:ownerId/calendars',
        async ({ params, user }): Promise<CalendarItem[]> => {
            requireNonGuest(user);
            const cal = await resolveCalendar(user, params.ownerId);
            return cal.getCalendars();
        },
        { auth: true },
    )

    .post(
        '/calendar/:ownerId/calendars',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const cal = await resolveCalendar(user, params.ownerId);
            return cal.createCalendar(body);
        },
        { body: CreateCalendarSchema, auth: true },
    )

    .put(
        '/calendar/:ownerId/calendars/:calId',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const cal = await resolveCalendar(user, params.ownerId);
            return await cal.updateCalendar(params.calId, body);
        },
        { body: UpdateCalendarSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/calendars/:calId',
        async ({ params, user }) => {
            requireNonGuest(user);
            const cal = await resolveCalendar(user, params.ownerId);
            await cal.deleteCalendar(params.calId);
            return { success: true };
        },
        { auth: true },
    )

    // --- Events ---
    // Multi-calendar event-range stays on `resolveCalendar` because it aggregates over every
    // calendar the caller owns (or the team home owns). Cross-user shared events are not
    // included here — they're fetched via the calId-scoped event-range below.
    .get(
        '/calendar/:ownerId/event-range/:from/:to',
        async ({ params, user }): Promise<CalendarEventOccurrence[]> => {
            requireNonGuest(user);
            const cal = await resolveCalendar(user, params.ownerId);
            return cal.getEventsInRange(new Date(params.from * 1000), new Date(params.to * 1000));
        },
        {
            params: t.Object({ ownerId: t.String(), from: t.Numeric(), to: t.Numeric() }),
            auth: true,
        },
    )

    .get(
        '/calendar/:ownerId/calendars/:calId/event-range/:from/:to',
        // Union return is intentional: free-busy callers get the redacted FreeBusyBlock shape (privacy
        // boundary below), everyone else the full events. The explicit annotation stabilises the Eden type.
        async ({ params, user }): Promise<CalendarEventOccurrence[] | FreeBusyBlock[]> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            const events = await pullEventsInRange(
                params.ownerId,
                params.calId,
                new Date(params.from * 1000),
                new Date(params.to * 1000),
            );
            if (permission === 'free-busy') {
                // Exclude canceled events: their existence + time must not leak into another
                // user's free/busy view, and excluding them makes the status cast below valid.
                return events
                    .filter((e) => e.status !== 'cancelled')
                    .map(
                        (e): FreeBusyBlock => ({
                            startTime: e.startTime,
                            endTime: e.endTime,
                            allDay: e.allDay,
                            status: e.status as FreeBusyBlock['status'],
                        }),
                    );
            }
            return events;
        },
        {
            params: t.Object({ ownerId: t.String(), calId: t.String(), from: t.Numeric(), to: t.Numeric() }),
            auth: true,
        },
    )

    .post(
        '/calendar/:ownerId/calendars/:calId/events',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            const recurrenceDate = body.recurrenceDate
                ? requireRecurrenceKey(body.recurrenceDate)
                : body.recurrenceDate;
            return createEventAt(
                params.ownerId,
                params.calId,
                { ...body, recurrenceDate, createByUserId: user.id },
                user,
            );
        },
        { body: CreateEventSchema, auth: true },
    )

    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            return updateEventAt(params.ownerId, params.calId, params.id, body, user);
        },
        { body: UpdateEventSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            await deleteEventAt(params.ownerId, params.calId, params.id, user);
            return { success: true };
        },
        { auth: true },
    )

    // Atomic cross-calendar move — write on both source (:calId) and target calendar required. Server-owned
    // so it preserves the organizer link + timezone + data a client can't re-send (EventDataSchema strips
    // organizer) and never fires deleteEvent's decline. Both calendars belong to :ownerId's Home.
    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id/move',
        async ({ params, body, user }): Promise<CalendarEvent> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            const target = await checkCalendarAccess(user, params.ownerId, body.targetCalendarId);
            if (target.permission !== 'write') throw new ApiError(403, 'Write permission required');
            return moveEventAt(params.ownerId, params.calId, params.id, body.targetCalendarId);
        },
        { body: MoveEventSchema, auth: true },
    )

    // --- RSVP ---
    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id/rsvp',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            const recurrenceDate = body.recurrenceDate
                ? requireRecurrenceKey(body.recurrenceDate)
                : body.recurrenceDate;
            await home.calendar.rsvp(params.id, user, { ...body, recurrenceDate });
            return { success: true };
        },
        {
            body: t.Object({
                status: t.Union([t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
                scope: t.Optional(t.Union([t.Literal('this'), t.Literal('this-and-following'), t.Literal('all')])),
                recurrenceDate: t.Optional(t.String()),
                remove: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    )

    .get(
        '/calendar/:ownerId/calendars/:calId/access',
        async ({ params, user }): Promise<{ ownerUserId: string; shares: CalendarShare[] }> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            const calData = await pullCalendarById(params.ownerId, params.calId);
            if (!calData) throw new ApiError(404, 'Calendar not found');
            return { ownerUserId: params.ownerId, shares: permission === 'write' ? calData.shares || [] : [] };
        },
        { auth: true },
    )

    // Pull calendars that ownerId has shared with the calling user.
    // ownerId is NOT the caller — it's the calendar owner being queried.
    // Response is filtered to only include shares matching the caller's email/teams.
    .get(
        '/calendar/:ownerId/shared-with-me',
        async ({ params, user }) => {
            requireNonGuest(user);
            const memberships = await getMemberships(user.id);
            return pullCalendarShares(params.ownerId, user.email, memberships.teamIds);
        },
        { auth: true },
    )

    // --- Shared calendars ---
    // Lazy-syncs team calendars into the user's shared_calendars table on each read,
    // then returns all shared calendars (both team and individually shared).
    .get(
        '/calendar/:ownerId/shared',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return syncTeamCalendars(user);
        },
        { auth: true },
    )

    .put(
        '/calendar/:ownerId/shared/:id',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const cal = await resolveCalendar(user, user.id);
            return cal.updateSharedCalendar(params.id, body);
        },
        { body: UpdateSharedCalendarSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/shared/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const cal = await resolveCalendar(user, user.id);
            await cal.deleteSharedCalendar(params.id);
            return { success: true };
        },
        { auth: true },
    )

    // --- Export ---
    // One calendar, or the events `ids` name inside it, as one `.ics`. Read access is enough: own calendars
    // and the team home's, which a member reads without a share of their own.
    .post(
        '/calendar/:ownerId/export',
        async ({ params, body, user, set }): Promise<string> => {
            requireNonGuest(user);
            const cal = await resolveTransferCalendar(user, params.ownerId, body.calendarId, 'read');
            const text = await cal.exportEvents(body.calendarId, body.ids);
            // A one-event export is named after the event itself, a whole calendar after the calendar.
            // contentDisposition takes the path and the control characters out of it; the clamp keeps one
            // absurd title from filling the header.
            const only = body.ids?.length === 1 ? await cal.getEventById(body.calendarId, body.ids[0]) : null;
            const name = only?.title || (cal.calendarRow(body.calendarId)?.name ?? '');
            set.headers['Content-Type'] = ICS_CONTENT_TYPE;
            set.headers['Content-Disposition'] = contentDisposition(
                'attachment',
                `${name.trim().slice(0, 200) || 'calendar'}.ics`,
            );
            return text;
        },
        {
            // The same event ceiling the import side enforces: one selection can't outgrow one file.
            body: t.Object({
                calendarId: t.String({ minLength: 1 }),
                ids: t.Optional(t.Array(t.String(), { maxItems: ICS_IMPORT_MAX_EVENTS })),
            }),
            auth: true,
        },
    )

    // --- Import ---
    // A whole `.ics` into one calendar of the caller's own Home, or of a team home they may write in —
    // the same access `createEvent` takes.
    .post(
        '/calendar/:ownerId/import',
        async ({ params, query, request, user, server }): Promise<ImportCountsResult> => {
            requireNonGuest(user);
            const cal = await resolveTransferCalendar(user, params.ownerId, query.calendarId, 'write');
            // A file of a thousand events writes a row apiece before this answers — longer than any
            // server-wide idleTimeout, so exempt this request.
            server?.timeout(request, 0);
            const bytes = await readBoundedBodyBytes(request, ICS_MAX_BYTES);
            if (bytes === null) throw new ApiError(413, 'Upload too large');
            return cal.importEvents(query.calendarId, bytes);
        },
        { query: ImportQuerySchema, auth: true, parse: 'none' },
    )

    .post(
        '/calendar/:ownerId/import-from-drive',
        async ({ params, body, request, user, server }): Promise<ImportCountsResult> => {
            requireNonGuest(user);
            const cal = await resolveTransferCalendar(user, params.ownerId, body.calendarId, 'write');
            // Same idle-timeout exemption as the raw import route: silent until the last event lands.
            server?.timeout(request, 0);
            const bytes = await readImportSourceBytes(user, body, {
                accepts: isIcsFile,
                rejection: NOT_A_CALENDAR_FILE,
                maxBytes: ICS_MAX_BYTES,
            });
            return cal.importEvents(body.calendarId, bytes);
        },
        {
            body: ImportFromDriveIcsSchema,
            auth: true,
        },
    );
