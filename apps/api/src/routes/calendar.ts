import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getCalendar} from "../lib/calendar/calendar";
import type {TeamHome} from "../lib/home";
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
    visible: t.Optional(t.Boolean()),
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
    .get("/calendar/:ownerId/calendars", async ({params, user}) => {
        const cal = await resolveCalendar(user, params.ownerId);
        return cal.getCalendars();
    }, {auth: true})

    .post("/calendar/:ownerId/calendars", async ({params, body, user}) => {
        const cal = await resolveCalendar(user, params.ownerId);
        return cal.createCalendar(body);
    }, {body: CreateCalendarSchema, auth: true})

    .put("/calendar/:ownerId/calendars/:id", async ({params, body, user}) => {
        const cal = await resolveCalendar(user, params.ownerId);
        return await cal.updateCalendar(params.id, body);
    }, {body: UpdateCalendarSchema, auth: true})

    .delete("/calendar/:ownerId/calendars/:id", async ({params, user}) => {
        const cal = await resolveCalendar(user, params.ownerId);
        cal.deleteCalendar(params.id);
        return {success: true};
    }, {auth: true})

    // --- Events ---
    .get("/calendar/:ownerId/events/:from/:to", async ({params, user}) => {
        const from = Number(params.from);
        const to = Number(params.to);
        if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');
        const cal = await resolveCalendar(user, params.ownerId);
        return cal.getEventsInRange(from, to);
    }, {auth: true})

    .get("/calendar/:ownerId/calendars/:calId/events/:from/:to", async ({params, user}) => {
        const from = Number(params.from);
        const to = Number(params.to);
        if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');

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
        const eventBody = {...body, createByUserId: user.id};

        if (parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (!memberships.teamIds.includes(parsed.id)) throw new ApiError(403, 'Not a member of this team');
            const home = await getHome(params.ownerId);
            return home.calendar.createEvent(params.calId, eventBody);
        }

        if (params.ownerId === user.id) {
            const cal = await resolveCalendar(user, user.id);
            return cal.createEvent(params.calId, eventBody);
        }

        const {calendar, permission} = await resolveCalendarForSharedAccess(user, params.ownerId, params.calId);
        if (permission !== 'write') throw new ApiError(403, 'Write permission required');
        return calendar.createEvent(params.calId, eventBody);
    }, {body: CreateEventSchema, auth: true})

    .put("/calendar/:ownerId/events/:id", async ({params, body, user}) => {
        if (params.ownerId !== user.id) {
            const ownerHome = await getHome(params.ownerId);
            const event = ownerHome.calendar.getEventById(params.id);
            if (!event) throw new ApiError(404, 'Event not found');
            const memberships = await getMemberships(user.id);
            const permission = ownerHome.calendar.checkPermission(event.calendarId, user.email, memberships.teamIds);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            return ownerHome.calendar.updateEvent(params.id, body);
        }
        const cal = await resolveCalendar(user, user.id);
        return cal.updateEvent(params.id, body);
    }, {body: UpdateEventSchema, auth: true})

    .delete("/calendar/:ownerId/events/:id", async ({params, user}) => {
        if (params.ownerId !== user.id) {
            const ownerHome = await getHome(params.ownerId);
            const event = ownerHome.calendar.getEventById(params.id);
            if (!event) throw new ApiError(404, 'Event not found');
            const memberships = await getMemberships(user.id);
            const permission = ownerHome.calendar.checkPermission(event.calendarId, user.email, memberships.teamIds);
            if (permission !== 'write') throw new ApiError(403, 'Write permission required');
            ownerHome.calendar.deleteEvent(params.id);
            return {success: true};
        }
        const cal = await resolveCalendar(user, user.id);
        cal.deleteEvent(params.id);
        return {success: true};
    }, {auth: true})

    .get("/calendar/:ownerId/calendars/:calId/access", async ({params, user}) => {
        if (params.ownerId === user.id) {
            const cal = await resolveCalendar(user, user.id);
            const calendar = cal.getCalendarById(params.calId);
            if (!calendar) throw new ApiError(404, 'Calendar not found');
            return {ownerUserId: user.id, shares: calendar.shares || []};
        }
        const {calendar} = await resolveCalendarForSharedAccess(user, params.ownerId, params.calId);
        const calData = calendar.getCalendarById(params.calId);
        if (!calData) throw new ApiError(404, 'Calendar not found');
        return {ownerUserId: params.ownerId, shares: calData.shares || []};
    }, {auth: true})

    // --- Pull shared-with-me from a specific owner ---
    .get("/calendar/:ownerId/shared-with-me", async ({params, user}) => {
        const ownerHome = await getHome(params.ownerId);
        const memberships = await getMemberships(user.id);
        return ownerHome.calendar.getSharedWith(user.email, memberships.teamIds);
    }, {auth: true})

    // --- Team settings ---
    .get("/calendar/team/:teamId/settings", async ({params, user}) => {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(params.teamId)) throw new ApiError(403, 'Not a member of this team');
        const teamHome = await getHome(`team_${params.teamId}`) as TeamHome;
        return teamHome.settings.get().calendar || {};
    }, {auth: true})

    .put("/calendar/team/:teamId/settings", async ({params, body, user}) => {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(params.teamId)) throw new ApiError(403, 'Not a member of this team');
        const teamHome = await getHome(`team_${params.teamId}`) as TeamHome;
        const updated = await teamHome.settings.set({calendar: body});
        return updated.calendar || {};
    }, {body: t.Object({enabled: t.Optional(t.Boolean())}), auth: true})

    // --- Shared calendars ---
    .get("/calendar/:ownerId/shared", async ({user}) => {
        const cal = await resolveCalendar(user, user.id);
        const memberships = await getMemberships(user.id);
        for (const teamId of memberships.teamIds) {
            const teamOwner = `team_${teamId}`;
            try {
                const teamHome = await getHome(teamOwner);
                const teamCal = teamHome.calendar;
                for (const tc of teamCal.getCalendars()) {
                    const permission = teamCal.checkPermission(tc.id, user.email, memberships.teamIds) || 'read';
                    cal.ensureSharedEntry(teamOwner, tc.id, tc.name, tc.color, permission);
                }
            } catch {
                cal.removeSharedEntriesForOwner(teamOwner);
            }
        }
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
