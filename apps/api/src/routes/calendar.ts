import { CALENDAR_NAME_MAX_LENGTH, ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    FreeBusyBlock,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { ICS_CONTENT_TYPE, isIcsFile } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { Elysia, t } from 'elysia';
import { checkCalendarAccess, resolveCalendar, syncTeamCalendars } from '../lib/calendar/get-calendar';
import { EVENT_MAX_BYTES } from '../lib/calendar/resource-store';
import { ApiError, ICS_IMPORT_MAX_EVENTS, NOT_A_CALENDAR_FILE } from '../lib/core';
import { requireNonGuest, requireSelf, requireTeamAdmin } from '../lib/core/access';
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
import { getMemberships, type User } from '../lib/user';
import { betterAuth } from './auth';
import { importFromDriveSchema } from './shared-schemas';

// Field bounds in front of the event ceiling. TEXT is for the ids and keys Eigen mints; everything a CalDAV
// PUT may store caps at the resource ceiling itself, or the event a device wrote would be uneditable here.
const TEXT = { maxLength: 512 };
const FREE_TEXT = { maxLength: EVENT_MAX_BYTES };
// An attendee or a reminder is one line of the file, and a file holds no more lines than it holds bytes.
const LINES = { maxItems: EVENT_MAX_BYTES };
const NAME = { maxLength: CALENDAR_NAME_MAX_LENGTH };

const CalendarShareSchema = t.Object({
    targetId: t.String(TEXT),
    permission: t.Union([t.Literal('free-busy'), t.Literal('read'), t.Literal('write')]),
});

const CreateCalendarSchema = t.Object({
    name: t.String(NAME),
    color: t.Optional(t.String(TEXT)),
});

const UpdateCalendarSchema = t.Object({
    name: t.Optional(t.String(NAME)),
    color: t.Optional(t.String(TEXT)),
    visible: t.Optional(t.Boolean()),
    shares: t.Optional(t.Nullable(t.Array(CalendarShareSchema, { maxItems: 100 }))),
});

const ReminderSchema = t.Object({
    type: t.Union([t.Literal('notification'), t.Literal('email')]),
    minutes: t.Number(),
});

// A CAL-ADDRESS is a URI and a CN is free text, so both are the file's to spell however long.
const AttendeeSchema = t.Object({
    email: t.String(FREE_TEXT),
    name: t.Optional(t.String(FREE_TEXT)),
    status: t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
    role: t.Union([t.Literal('required'), t.Literal('optional')]),
});

const EventDataSchema = t.Object({
    reminders: t.Optional(t.Array(ReminderSchema, LINES)),
    attendees: t.Optional(t.Array(AttendeeSchema, LINES)),
    url: t.Optional(t.String(FREE_TEXT)),
    color: t.Optional(t.String(TEXT)),
});

const CreateEventSchema = t.Object({
    title: t.String(FREE_TEXT),
    startTime: t.Date(),
    endTime: t.Date(),
    allDay: t.Boolean(),
    description: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    location: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    rrule: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    timezone: t.Optional(t.Nullable(t.String(TEXT))),
    parentEventId: t.Optional(t.Nullable(t.String(TEXT))),
    recurrenceDate: t.Optional(t.Nullable(t.String(TEXT))),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const UpdateEventSchema = t.Object({
    title: t.Optional(t.String(FREE_TEXT)),
    startTime: t.Optional(t.Date()),
    endTime: t.Optional(t.Date()),
    allDay: t.Optional(t.Boolean()),
    description: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    location: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    rrule: t.Optional(t.Nullable(t.String(FREE_TEXT))),
    timezone: t.Optional(t.Nullable(t.String(TEXT))),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const MoveEventSchema = t.Object({
    targetCalendarId: t.String(TEXT),
});

const UpdateSharedCalendarSchema = t.Object({
    color: t.Optional(t.Nullable(t.String(TEXT))),
    visible: t.Optional(t.Boolean()),
});

const ImportFromDriveIcsSchema = t.Object({
    ...importFromDriveSchema.properties,
    calendarId: t.String({ ...TEXT, minLength: 1 }),
});

const ImportQuerySchema = t.Object({ calendarId: t.String({ ...TEXT, minLength: 1 }) });

// A team home is the only foreign Home a transfer may touch — only the relay crosses homes — and free-busy is no read here.
async function resolveTransferCalendar(user: User, ownerId: string, calendarId: string, need: 'read' | 'write') {
    if (parseOwnerId(ownerId).type !== 'team') requireSelf(ownerId, user.id);
    const { permission } = await checkCalendarAccess(user, ownerId, calendarId);
    if (permission === 'free-busy' || (need === 'write' && permission !== 'write')) {
        throw new ApiError(403, need === 'write' ? 'Write permission required' : 'Read permission required');
    }
    return resolveCalendar(user, ownerId);
}

// A team home's calendar collection is admin-only: a member's write share on a team calendar is event-level.
async function resolveAdministeredCalendar(user: User, ownerId: string) {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') return resolveCalendar(user, ownerId);
    await requireTeamAdmin(user.id, parsed.id);
    return (await getHome(ownerId)).calendar;
}

// A team admin sets the shares of a team calendar, so the list those shares are read off is theirs too; the events stay on membership.
async function resolveListedCalendar(user: User, ownerId: string) {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') return resolveCalendar(user, ownerId);
    const { teamIds } = await getMemberships(user.id);
    return teamIds.includes(parsed.id) ? resolveCalendar(user, ownerId) : resolveAdministeredCalendar(user, ownerId);
}

// These routes carry a foreign `:ownerId`, and a foreign home is only ever reached through `home-relay.ts`.
export const calendarRouter = new Elysia({ name: 'calendar' })
    .use(betterAuth)

    // --- Calendars ---
    .get(
        '/calendar/:ownerId/calendars',
        async ({ params, user }): Promise<CalendarItem[]> => {
            requireNonGuest(user);
            const cal = await resolveListedCalendar(user, params.ownerId);
            return cal.getCalendars();
        },
        { auth: true },
    )

    .post(
        '/calendar/:ownerId/calendars',
        async ({ params, body, user }): Promise<CalendarItem> => {
            requireNonGuest(user);
            const cal = await resolveAdministeredCalendar(user, params.ownerId);
            return cal.createCalendar(body);
        },
        { body: CreateCalendarSchema, auth: true },
    )

    .put(
        '/calendar/:ownerId/calendars/:calId',
        async ({ params, body, user }): Promise<CalendarItem> => {
            requireNonGuest(user);
            const cal = await resolveAdministeredCalendar(user, params.ownerId);
            return await cal.updateCalendar(params.calId, body);
        },
        { body: UpdateCalendarSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/calendars/:calId',
        async ({ params, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            const cal = await resolveAdministeredCalendar(user, params.ownerId);
            await cal.deleteCalendar(params.calId);
            return { success: true };
        },
        { auth: true },
    )

    // --- Events ---
    // Aggregates the owner's own calendars only: cross-user shared events come from the calId-scoped route below.
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
        // The explicit union annotation stabilises the Eden type: a free-busy caller gets the redacted shape.
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
                // A cancelled event's existence must not leak into a free/busy view, and dropping it makes the cast valid.
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
        async ({ params, body, user }): Promise<CalendarEvent> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            return createEventAt(params.ownerId, params.calId, { ...body, createByUserId: user.id }, user);
        },
        { body: CreateEventSchema, auth: true },
    )

    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, body, user }): Promise<CalendarEvent> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            return updateEventAt(params.ownerId, params.calId, params.id, body, user);
        },
        { body: UpdateEventSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            await deleteEventAt(params.ownerId, params.calId, params.id, user);
            return { success: true };
        },
        { auth: true },
    )

    // Server-owned so the move keeps the organizer link, timezone and data a client cannot re-send, and declines nothing.
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
        async ({ params, body, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            await home.calendar.rsvp(params.id, user, body);
            return { success: true };
        },
        {
            body: t.Object({
                status: t.Union([t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
                scope: t.Optional(t.Union([t.Literal('this'), t.Literal('this-and-following'), t.Literal('all')])),
                recurrenceDate: t.Optional(t.String(TEXT)),
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

    // `:ownerId` is the queried calendar owner, not the caller, and the answer holds only the caller's own shares.
    .get(
        '/calendar/:ownerId/shared-with-me',
        async ({
            params,
            user,
        }): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> => {
            requireNonGuest(user);
            const memberships = await getMemberships(user.id);
            return pullCalendarShares(params.ownerId, user.email, memberships.teamIds);
        },
        { auth: true },
    )

    // --- Shared calendars ---
    .get(
        '/calendar/:ownerId/shared',
        async ({ params, user }): Promise<SharedCalendar[]> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return syncTeamCalendars(user);
        },
        { auth: true },
    )

    .put(
        '/calendar/:ownerId/shared/:id',
        async ({ params, body, user }): Promise<SharedCalendar> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const cal = await resolveCalendar(user, user.id);
            return cal.updateSharedCalendar(params.id, body);
        },
        { body: UpdateSharedCalendarSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/shared/:id',
        async ({ params, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const cal = await resolveCalendar(user, user.id);
            await cal.deleteSharedCalendar(params.id);
            return { success: true };
        },
        { auth: true },
    )

    // --- Export ---
    // Read access is enough: a team member exports the team home's calendar without a share of their own.
    .post(
        '/calendar/:ownerId/export',
        async ({ params, body, user, set }): Promise<string> => {
            requireNonGuest(user);
            const cal = await resolveTransferCalendar(user, params.ownerId, body.calendarId, 'read');
            const text = await cal.exportEvents(body.calendarId, body.ids);
            // The clamp keeps one absurd title out of the header; contentDisposition strips path and control characters.
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
                calendarId: t.String({ ...TEXT, minLength: 1 }),
                ids: t.Optional(t.Array(t.String(TEXT), { maxItems: ICS_IMPORT_MAX_EVENTS })),
            }),
            auth: true,
        },
    )

    // --- Import ---
    .post(
        '/calendar/:ownerId/import',
        async ({ params, query, request, user, server }): Promise<ImportCountsResult> => {
            requireNonGuest(user);
            const cal = await resolveTransferCalendar(user, params.ownerId, query.calendarId, 'write');
            // A thousand-event file writes a row apiece before this answers, longer than any server-wide idleTimeout.
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
