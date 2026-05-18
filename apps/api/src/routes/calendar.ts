import type { CalendarItem, FreeBusyBlock } from '@workspace/lib/types/calendar';
import { Elysia, t } from 'elysia';
import { checkCalendarAccess, resolveCalendar, syncTeamCalendars } from '../lib/calendar/get-calendar';
import { ApiError } from '../lib/core';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { getHome } from '../lib/home';
import {
    createEventAt,
    deleteEventAt,
    pullCalendarById,
    pullCalendarShares,
    pullEventsInRange,
    updateEventAt,
} from '../lib/home/home-relay';
import { getMemberships } from '../lib/user';
import { betterAuth } from './auth';

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
    email: t.String(),
    name: t.Optional(t.String()),
    status: t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
    role: t.Union([t.Literal('required'), t.Literal('optional')]),
});

const EventDataSchema = t.Object({
    reminders: t.Optional(t.Array(ReminderSchema)),
    attendees: t.Optional(t.Array(AttendeeSchema)),
    url: t.Optional(t.String()),
    notes: t.Optional(t.String()),
    color: t.Optional(t.String()),
});

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

const UpdateSharedCalendarSchema = t.Object({
    color: t.Optional(t.Nullable(t.String())),
    visible: t.Optional(t.Boolean()),
});

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
        async ({ params, user }) => {
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
        async ({ params, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            const events = await pullEventsInRange(
                params.ownerId,
                params.calId,
                new Date(params.from * 1000),
                new Date(params.to * 1000),
            );
            if (permission === 'free-busy') {
                return events.map(
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
            return createEventAt(params.ownerId, params.calId, { ...body, createByUserId: user.id }, user);
        },
        { body: CreateEventSchema, auth: true },
    )

    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            return updateEventAt(params.ownerId, params.id, body, user);
        },
        { body: UpdateEventSchema, auth: true },
    )

    .delete(
        '/calendar/:ownerId/calendars/:calId/events/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            await deleteEventAt(params.ownerId, params.id, user);
            return { success: true };
        },
        { auth: true },
    )

    // --- RSVP ---
    .put(
        '/calendar/:ownerId/calendars/:calId/events/:id/rsvp',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            home.calendar.rsvp(params.id, user, body);
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
        async ({ params, user }) => {
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
            cal.deleteSharedCalendar(params.id);
            return { success: true };
        },
        { auth: true },
    );
