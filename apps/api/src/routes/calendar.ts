import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getCalendar} from "../lib/calendar/calendar";
import {getHome} from "../lib/home";
import {getMemberships} from "../lib/user";
import {parseOwnerId} from "@workspace/lib/types";
import {ApiError} from "../lib/core";
import type {CalendarShare, FreeBusyBlock} from "@workspace/lib/types/calendar";

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
    shares: t.Optional(t.Nullable(t.Array(CalendarShareSchema))),
});

const ReminderSchema = t.Object({
    type: t.Union([t.Literal('notification'), t.Literal('email')]),
    minutes: t.Number(),
});

const EventDataSchema = t.Object({
    reminders: t.Optional(t.Array(ReminderSchema)),
    url: t.Optional(t.String()),
    notes: t.Optional(t.String()),
    color: t.Optional(t.String()),
});

const CreateEventSchema = t.Object({
    title: t.String(),
    startTime: t.Number(),
    endTime: t.Number(),
    allDay: t.Boolean(),
    description: t.Optional(t.Nullable(t.String())),
    location: t.Optional(t.Nullable(t.String())),
    rrule: t.Optional(t.Nullable(t.String())),
    parentEventId: t.Optional(t.Nullable(t.String())),
    recurrenceDate: t.Optional(t.Nullable(t.String())),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const UpdateEventSchema = t.Object({
    title: t.Optional(t.String()),
    startTime: t.Optional(t.Number()),
    endTime: t.Optional(t.Number()),
    allDay: t.Optional(t.Boolean()),
    description: t.Optional(t.Nullable(t.String())),
    location: t.Optional(t.Nullable(t.String())),
    rrule: t.Optional(t.Nullable(t.String())),
    status: t.Optional(t.Union([t.Literal('confirmed'), t.Literal('tentative'), t.Literal('cancelled')])),
    data: t.Optional(t.Nullable(EventDataSchema)),
});

const UpdateSharedCalendarSchema = t.Object({
    color: t.Optional(t.Nullable(t.String())),
    visible: t.Optional(t.Boolean()),
});

async function resolveCalendar(user: {id: string; email: string}, ownerId: string) {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(parsed.id)) {
            throw new ApiError(403, 'Not a member of this team');
        }
    }
    const home = await getHome(parsed.type === 'team' ? ownerId : user.id);
    return home.calendar;
}

async function resolveCalendarForSharedAccess(
    requestingUser: {id: string; email: string},
    ownerId: string,
    calendarId: string,
): Promise<{calendar: Awaited<ReturnType<typeof getCalendar>>; permission: CalendarShare['permission']}> {
    const ownerHome = await getHome(ownerId);
    const memberships = await getMemberships(requestingUser.id);
    const permission = ownerHome.calendar.checkPermission(calendarId, requestingUser.email, memberships.teamIds);
    if (!permission) {
        throw new ApiError(403, 'No access to this calendar');
    }
    return {calendar: ownerHome.calendar, permission};
}

export const calendarRouter = new Elysia({name: "calendar"})
    .use(betterAuth)

    // --- Calendars ---
    .get("/calendar/:ownerId/calendars", async ({user}) => {
        const cal = await resolveCalendar(user, user.id);
        return cal.getCalendars();
    }, {auth: true})

    .post("/calendar/:ownerId/calendars", async ({body, user}) => {
        const cal = await resolveCalendar(user, user.id);
        return cal.createCalendar(body);
    }, {body: CreateCalendarSchema, auth: true})

    .put("/calendar/:ownerId/calendars/:id", async ({params, body, user}) => {
        const cal = await resolveCalendar(user, user.id);
        return await cal.updateCalendar(params.id, body);
    }, {body: UpdateCalendarSchema, auth: true})

    .delete("/calendar/:ownerId/calendars/:id", async ({params, user}) => {
        const cal = await resolveCalendar(user, user.id);
        cal.deleteCalendar(params.id);
        return {success: true};
    }, {auth: true})

    // --- Events ---
    .get("/calendar/:ownerId/events", async ({query, user}) => {
        const from = Number(query['from']);
        const to = Number(query['to']);
        if (!from || !to) throw new ApiError(400, 'Missing from/to query parameters');
        const cal = await resolveCalendar(user, user.id);
        return cal.getEventsInRange(from, to);
    }, {auth: true})

    .get("/calendar/:ownerId/calendars/:calId/events", async ({params, query, user}) => {
        const from = Number(query['from']);
        const to = Number(query['to']);
        if (!from || !to) throw new ApiError(400, 'Missing from/to query parameters');

        const parsed = parseOwnerId(params.ownerId);

        if (parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (!memberships.teamIds.includes(parsed.id)) throw new ApiError(403, 'Not a member of this team');
            const home = await getHome(params.ownerId);
            return home.calendar.getEventsInRange(from, to, params.calId);
        }

        if (params.ownerId === user.id) {
            const cal = await resolveCalendar(user, user.id);
            return cal.getEventsInRange(from, to, params.calId);
        }

        const {calendar, permission} = await resolveCalendarForSharedAccess(user, params.ownerId, params.calId);
        const events = calendar.getEventsInRange(from, to, params.calId);

        if (permission === 'free-busy') {
            return events.map((e): FreeBusyBlock => ({
                startTime: e.startTime,
                endTime: e.endTime,
                allDay: e.allDay,
                status: e.status as FreeBusyBlock['status'],
            }));
        }
        return events;
    }, {auth: true})

    .post("/calendar/:ownerId/calendars/:calId/events", async ({params, body, user}) => {
        const parsed = parseOwnerId(params.ownerId);

        if (parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (!memberships.teamIds.includes(parsed.id)) throw new ApiError(403, 'Not a member of this team');
            const home = await getHome(params.ownerId);
            return home.calendar.createEvent(params.calId, body);
        }

        if (params.ownerId === user.id) {
            const cal = await resolveCalendar(user, user.id);
            return cal.createEvent(params.calId, body);
        }

        const {calendar, permission} = await resolveCalendarForSharedAccess(user, params.ownerId, params.calId);
        if (permission !== 'write') throw new ApiError(403, 'Write permission required');
        return calendar.createEvent(params.calId, body);
    }, {body: CreateEventSchema, auth: true})

    .put("/calendar/:ownerId/events/:id", async ({params, body, user}) => {
        const cal = await resolveCalendar(user, user.id);
        return cal.updateEvent(params.id, body);
    }, {body: UpdateEventSchema, auth: true})

    .delete("/calendar/:ownerId/events/:id", async ({params, user}) => {
        const cal = await resolveCalendar(user, user.id);
        cal.deleteEvent(params.id);
        return {success: true};
    }, {auth: true})

    // --- Shared calendars ---
    .get("/calendar/:ownerId/shared", async ({user}) => {
        const cal = await resolveCalendar(user, user.id);
        return cal.getSharedCalendars();
    }, {auth: true})

    .put("/calendar/:ownerId/shared/:id", async ({params, body, user}) => {
        const cal = await resolveCalendar(user, user.id);
        return cal.updateSharedCalendar(params.id, body);
    }, {body: UpdateSharedCalendarSchema, auth: true})

    .delete("/calendar/:ownerId/shared/:id", async ({params, user}) => {
        const cal = await resolveCalendar(user, user.id);
        cal.deleteSharedCalendar(params.id);
        return {success: true};
    }, {auth: true});
