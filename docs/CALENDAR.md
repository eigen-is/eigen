# Calendar App

> **TLDR**: Per-user SQLite calendar at `{home}/eigen.calendar/calendar.db`. RRULE strings stored as-is (RFC 5545).
> Sharing via push-based propagation (like Drive ACL). Team calendars in TeamHome. Three permission levels: `free-busy`,
> `read`, `write`. Recurrence exceptions are regular events with `parentEventId` + `recurrenceDate`. Timezone-aware
> recurrence expansion via `timezone` column on events.

## Storage

```
data/home/{userId}/eigen.calendar/calendar.db
data/team/{teamId}/eigen.calendar/calendar.db
```

Follows the Contacts/Mail pattern — per-user Home directory, not Drive.

## Schema

### calendars

| Column      | Type    | Description                                    |
|-------------|---------|------------------------------------------------|
| `id`        | TEXT PK | UUID                                           |
| `name`      | TEXT    | Display name                                   |
| `color`     | TEXT    | Hex color                                      |
| `isDefault` | INTEGER | Primary calendar (auto-created, cannot delete) |
| `visible`   | INTEGER | Toggle visibility in UI (default true)         |
| `ctag`      | INTEGER | Increments on any event change (CalDAV-ready)  |
| `shares`    | TEXT    | JSON `CalendarShare[]`                         |
| `createdAt` | INTEGER | Timestamp                                      |
| `updatedAt` | INTEGER | Timestamp                                      |

### events

| Column             | Type    | Description                                       |
|--------------------|---------|---------------------------------------------------|
| `id`               | TEXT PK | UUID                                              |
| `calendarId`       | TEXT FK | → calendars.id                                    |
| `uid`              | TEXT    | iCalendar UID (CalDAV-ready)                      |
| `title`            | TEXT    | Summary                                           |
| `description`      | TEXT    | Nullable                                          |
| `location`         | TEXT    | Nullable                                          |
| `startTime`        | INTEGER | Unix timestamp                                    |
| `endTime`          | INTEGER | Unix timestamp                                    |
| `allDay`           | INTEGER | Boolean                                           |
| `rrule`            | TEXT    | RFC 5545 RRULE string (nullable)                  |
| `timezone`         | TEXT    | IANA timezone for recurrence expansion (nullable) |
| `uri`              | TEXT    | iCalendar URI (CalDAV-ready)                      |
| `parentEventId`    | TEXT FK | Recurrence exception parent                       |
| `recurrenceDate`   | TEXT    | ISO date of replaced occurrence                   |
| `status`           | TEXT    | `confirmed` / `tentative` / `cancelled`           |
| `etag`             | TEXT    | Change hash (CalDAV-ready)                        |
| `data`             | TEXT    | JSON: reminders, attendees, url, notes, color     |
| `organizerEventId` | TEXT    | Linked copy → organizer's event ID (nullable)     |
| `organizerUserId`  | TEXT    | Linked copy → organizer's user ID (nullable)      |
| `sequence`         | INTEGER | CalDAV SEQUENCE — bumped on organizer updates     |
| `createByUserId`   | TEXT    | User who created the event                        |
| `createdAt`        | INTEGER | Timestamp                                         |
| `updatedAt`        | INTEGER | Timestamp                                         |

### shared_calendars (recipient-side)

| Column          | Type    | Description                    |
|-----------------|---------|--------------------------------|
| `id`            | TEXT PK | UUID                           |
| `ownerUserId`   | TEXT    | Calendar owner                 |
| `calendarId`    | TEXT    | ID in owner's DB               |
| `calendarName`  | TEXT    | Cached name                    |
| `calendarColor` | TEXT    | Owner's color                  |
| `permission`    | TEXT    | `free-busy` / `read` / `write` |
| `color`         | TEXT    | Local override (nullable)      |
| `visible`       | INTEGER | Toggle visibility              |
| `createdAt`     | INTEGER | Timestamp                      |
| `updatedAt`     | INTEGER | Timestamp                      |

## Sharing

**Permissions**: `free-busy` (time blocks only), `read` (full details), `write` (can edit).

Push-based propagation — when shares change, `share-propagation.ts` resolves targets and writes to recipient's
`shared_calendars`. See [ACL.md](ACL.md#share-propagation).

**Team calendars**: Auto-synced into the user's `shared_calendars` table (with `ownerUserId = 'team_{teamId}'`) when
`GET /calendar/:ownerId/shared` is called. Can be disabled via `settings.json` in the team home dir
(`calendar.enabled: false`). Default member permission is `read`. To grant `write` or `free-busy`, set shares on the
team's default calendar: `{targetId: 'team_{teamId}', permission: 'write'}`. Permission is resolved via
`checkPermission()` and synced on every fetch. When disabled, the `TeamHome.calendar` getter throws a 404, so
`syncTeamCalendars` catches the error and removes entries from members' `shared_calendars`.
Displayed in a separate "Team Calendars" section in the sidebar, using the same `SharedCalendar` infrastructure for
visibility/color prefs. Managed in the People app team detail page (via `PUT /team/:teamId/settings`).

## Invitations

Organizer creates event with `data.attendees[]` → server writes a linked copy to each attendee's default calendar →
attendees RSVP → status propagates back to organizer. All server-side, no email needed.

**Linked events**: Regular events in the attendee's calendar with `organizerEventId`/`organizerUserId` columns set
(indexed for fast lookup). Same `uid` as organizer's event (CalDAV requirement). `data.organizer` is also set with
`{ userId, email, name? }` and `data.organizerEventId`. DB-level detection: `organizerEventId IS NOT NULL` (used by
`findLinkedEvent`). Application-level detection: `event.data.organizer` is present (used by `updateEvent` guard and
`deleteEvent` decline logic).

**Propagation** (`invite-propagation.ts`):
- Create/update with attendees: diff old vs new → add/remove/update linked copies + SSE notifications
- Delete by organizer: cancel all attendee copies
- Delete by attendee: treated as decline (propagates `declined` status to organizer)
- Self-invite prevention: organizer's email is skipped during propagation
- Unknown email: added to share registry for reconciliation on signup

**RSVP**: Attendee calls `PUT .../events/:id/rsvp` with `{status, scope?, recurrenceDate?, remove?}`.

- `scope='all'` (default): updates attendee status on the linked event + propagates to organizer
- `scope='this'` + `recurrenceDate`: creates a recurrence exception with per-occurrence attendee status + propagates
  to organizer (who also gets an exception). With `remove: true`, creates a cancelled exception instead (hides
  occurrence) and propagates decline
- `scope='this-and-following'` + `recurrenceDate` + `remove: true`: truncates the linked event's rrule + propagates
  series-wide decline
- `remove: true` without scope: deletes the entire linked event (same as DELETE, propagates decline)

All handled by `Calendar.rsvp()`. Per-occurrence data is stored as recurrence exceptions (`parentEventId` +
`recurrenceDate`), reusing the existing expansion model — `getEventsInRange()` already substitutes exception data.

**rrule constraint**: When an organizer updates a recurring invited event, `receiveInvitationUpdate()` ensures the
incoming rrule does not extend beyond any local truncation the attendee made. This prevents "delete this and following"
from being undone by an organizer edit.

**Linked event guard**: Attendees can only change `data.reminders` and `data.color` on linked copies. Title, time,
description, location, rrule changes are blocked by `updateEvent()`. Detection: `event.data.organizer` is present
(not the DB column `organizerEventId`).

**SSE events**: `calendar:invite-received`, `calendar:invite-updated`, `calendar:invite-cancelled`, `calendar:invite-rsvp`.

## SSE Events

Full list of calendar SSE events (defined in `packages/lib/src/types/sse.ts`):

| Event                       | Trigger                           |
|-----------------------------|-----------------------------------|
| `calendar:calendar-created` | Calendar created                  |
| `calendar:calendar-updated` | Calendar updated (name/color/shares) |
| `calendar:calendar-deleted` | Calendar deleted                  |
| `calendar:event-created`    | Event created                     |
| `calendar:event-updated`    | Event updated                     |
| `calendar:event-deleted`    | Event deleted                     |
| `calendar:shared`           | Calendar shared with user         |
| `calendar:unshared`         | Calendar share removed            |
| `calendar:invite-received`  | Invitation received by attendee   |
| `calendar:invite-updated`   | Invitation updated by organizer   |
| `calendar:invite-cancelled` | Invitation cancelled by organizer |
| `calendar:invite-rsvp`      | Attendee RSVP propagated to organizer |

Shared calendar users are also notified via `notifySharedCalendarUsers()` when events are created/updated/deleted.

## Recurrence

- RRULE strings stored/transmitted as-is (no conversion layer)
- Expansion via `rrule` npm package: `new RRule({...RRule.parseString(rrule), dtstart}).between(from, to)`
- **Never store expanded occurrences** — expand in memory per query
- **Exceptions**: Regular events with `parentEventId` + `recurrenceDate`. Cancel = `status: 'cancelled'`, modify =
  different data at that date

## All-Day Events

`startTime`/`endTime` are midnight UTC. `endTime` is exclusive (day after last day). Frontend must use UTC date portion,
never convert to local time.

## API Routes

`apps/api/src/routes/calendar.ts`, `ownerId` can be user ID or `team_{teamId}`:

```
GET    /calendar/:ownerId/calendars
POST   /calendar/:ownerId/calendars
PUT    /calendar/:ownerId/calendars/:calId        (includes shares)
DELETE /calendar/:ownerId/calendars/:calId
GET    /calendar/:ownerId/event-range/:from/:to   (all calendars)
GET    /calendar/:ownerId/calendars/:calId/event-range/:from/:to
POST   /calendar/:ownerId/calendars/:calId/events
PUT    /calendar/:ownerId/calendars/:calId/events/:id
DELETE /calendar/:ownerId/calendars/:calId/events/:id
PUT    /calendar/:ownerId/calendars/:calId/events/:id/rsvp   (attendee RSVP)
GET    /calendar/:ownerId/calendars/:calId/access
GET    /calendar/:ownerId/shared                  (shared-with-me list, auto-syncs team calendars)
PUT    /calendar/:ownerId/shared/:id              (local prefs)
DELETE /calendar/:ownerId/shared/:id
GET    /calendar/:ownerId/shared-with-me          (pull: what has owner shared with me?)
```

Team calendar settings (enable/disable, member permission) are managed via the team router, not the calendar router:

```
GET    /team/:teamId/settings                     (includes calendar.enabled)
PUT    /team/:teamId/settings                     (update: {calendar: {enabled}})
```

Events endpoint returns `CalendarEventOccurrence[]` — expanded occurrences with `occurrenceDate` field. Free-busy
permission returns time blocks only.

## Types

```typescript
type CalendarShare = { targetId: string; permission: 'free-busy' | 'read' | 'write' }
type CalendarItem = { id, name, color, isDefault, visible, shares: CalendarShare[] | null, createdAt, updatedAt }
type CalendarEvent = { id, calendarId, uid, uri, title, description, location, startTime, endTime, allDay, rrule, timezone, parentEventId, recurrenceDate, status, sequence, etag, data, createByUserId, createdAt, updatedAt }
type CalendarEventOccurrence = CalendarEvent & { occurrenceDate: string }
type FreeBusyBlock = { startTime, endTime, allDay, status: 'confirmed' | 'tentative' }
type SharedCalendar = { id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible, createdAt, updatedAt }
type Attendee = { email, name?, status: 'pending'|'accepted'|'declined'|'tentative', role: 'required'|'optional' }
type EventData = { reminders?: Reminder[], attendees?: Attendee[], organizer?: { userId, email, name? }, organizerEventId?, url?, notes?, color? }
```

Defined in `packages/lib/src/types/calendar.ts`.

## Frontend Hooks

All hooks in `packages/lib/src/core/calendar/hooks/use-calendar.ts`:

| Hook                          | Purpose                                    |
|-------------------------------|--------------------------------------------|
| `useCalendars(ownerId)`       | List calendars for an owner                |
| `useCreateCalendar(ownerId)`  | Create calendar mutation                   |
| `useUpdateCalendar(ownerId)`  | Update calendar mutation (name/color/shares/visible) |
| `useDeleteCalendar(ownerId)`  | Delete calendar mutation                   |
| `useEvents(ownerId, from, to)` | All events in time range (all calendars)  |
| `useCalendarEvents(ownerId, calId, from, to)` | Events for a single calendar |
| `useCreateEvent(ownerId)`     | Create event mutation                      |
| `useUpdateEvent(ownerId)`     | Update event mutation                      |
| `useDeleteEvent(ownerId)`     | Delete event mutation                      |
| `useCalendarAccess(ownerId, calId)` | Get calendar shares (if `write` permission) |
| `useAllSharedCalendarEvents(sharedCalendars, from, to)` | Parallel queries for all visible shared calendar events |
| `useSharedCalendars(ownerId)` | List shared calendars (triggers team sync) |
| `useUpdateSharedCalendar(ownerId)` | Update local prefs (color/visible)    |
| `useDeleteSharedCalendar(ownerId)` | Remove shared calendar entry          |
| `useRsvp(ownerId)`            | RSVP mutation (accept/decline/tentative)   |

**Query keys**: `calendarKeys` with `ownerId`-scoped hierarchy — `all > owner(ownerId) > calendars/events/shared`.
SSE handler in `packages/lib/src/core/calendar/sse-handlers.ts` routes events to invalidation functions.

## Files

| File                                             | Purpose                   |
|--------------------------------------------------|---------------------------|
| `apps/api/src/lib/calendar/calendar.ts`          | Calendar class            |
| `apps/api/src/lib/calendar/get-calendar.ts`      | Access resolution (like Drive's `get-drive.ts`) |
| `apps/api/src/lib/calendar/schema.ts`            | Drizzle schema            |
| `apps/api/src/lib/calendar/db-config.ts`         | DB config + migrations    |
| `apps/api/src/lib/calendar/share-propagation.ts`  | Push shares to recipients |
| `apps/api/src/lib/calendar/invite-propagation.ts` | Push invites to attendees |
| `apps/api/src/lib/calendar/sse-events.ts`         | SSE builders              |
| `apps/api/src/routes/calendar.ts`                 | API routes (thin)         |
| `packages/lib/src/types/calendar.ts`             | Shared types              |
| `packages/lib/src/core/calendar/`                | FE hooks + SSE handlers   |
