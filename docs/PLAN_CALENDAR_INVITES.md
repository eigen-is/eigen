# Plan: Calendar Event Invites

## Overview

Add the ability for Eigen users to invite other users to calendar events with RSVP tracking.

**How it works:** Organizer creates event with attendees → server writes a linked copy to each attendee's calendar →
attendees RSVP → status propagates back to organizer. All server-side, no email needed. Same model as Google Calendar /
Microsoft Outlook for internal users, minus the iMIP email layer (see "Future: External/Guest Invites" at the bottom).

**What Eigen already has:**

- Per-user SQLite calendar databases with `data` JSON column on events
- `EventData` type already declares `attendees`, `organizer`, `organizerEventId` fields (unused so far)
- Push-based calendar sharing with SSE, `reconcileSharesForNewUser()`, team calendar support
- Route validation (`EventDataSchema`) that already correctly excludes `organizer`/`organizerEventId` from client input

**What this plan adds:**

- Attendee picker in create/edit event dialogs
- Server-side invite propagation (linked event copies)
- RSVP endpoint + UI
- Invite SSE notifications
- Registry-based reconciliation for future/offline users

---

## Data Model

### Types (`packages/lib/src/types/calendar.ts` — no changes needed)

`Attendee`, `EventData` (with `attendees`, `organizer`, `organizerEventId` fields), `CalendarEvent` (has `calendarId`),
`CreateEventInput`, `UpdateEventInput` — all already defined.

### Schema: add indexed columns (`apps/api/src/lib/calendar/schema.ts`)

Add two columns + index to the `events` table:

```typescript
organizerEventId: text('organizerEventId'),
        organizerUserId
:
text('organizerUserId'),
```

```typescript
linkedEvent: index('idx_events_linked').on(table.organizerEventId, table.organizerUserId),
```

Set only on attendee linked copies (by `receiveInvitation()`). Organizer events leave them null. Indexed columns avoid
full-table JSON scans on every update/delete/RSVP. The same values also live in `data` JSON for frontend display.
Data is throwaway during dev — no migration needed.

### Route validation: add `attendees` only (`apps/api/src/routes/calendar.ts`)

```typescript
const AttendeeSchema = t.Object({
    email: t.String(),
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
```

`organizer` and `organizerEventId` are deliberately **NOT** in the route schema — the existing schema already correctly
blocks them. They are server-only fields set exclusively by `receiveInvitation()`, preventing client forgery.

### How linked events work

**Organizer's event:** `data.attendees[]` with invitee emails + status. No `data.organizer`. Columns
`organizerEventId`/`organizerUserId` are null.

**Attendee's linked copy:** Regular event in attendee's default calendar with:

- Same title, description, location, times, rrule
- `data.organizer = { userId, email }` + `data.organizerEventId` (for frontend display)
- `data.attendees` = snapshot at invite time (not live-updated by peer RSVPs — see Design Decisions)
- `organizerEventId` + `organizerUserId` columns set (indexed server-side lookups)
- `createByUserId` = organizer's user ID

**Detection:** Event is a linked copy if `organizerEventId` column is non-null.

Default calendar for linked events: `this.getCalendars().find(c => c.isDefault)` — always exists
(`Calendar.init()` creates one).

---

## Calendar Class Methods (`apps/api/src/lib/calendar/calendar.ts`)

Synchronous methods (local SQLite only), matching existing `createEvent`/`updateEvent`/`deleteEvent` patterns.

### `findLinkedEvent(orgEventId: string, orgUserId: string): CalendarEvent | null`

Uses indexed columns (not JSON queries):

```typescript
const row = this.db.select().from(schema.events).where(
        and(
                eq(schema.events.organizerEventId, orgEventId),
                eq(schema.events.organizerUserId, orgUserId),
        )
).get();
return row ? dbEventToCalendarEvent(row) : null;
```

`CalendarEvent` already includes `calendarId`. `deleteEvent(id)` only needs the event `id`.

### `receiveInvitation(payload): string`

Creates linked event in attendee's default calendar. Returns created event ID. Idempotent — if linked event already
exists (same `organizerEventId` + `organizerUserId`), returns existing ID.

```typescript
receiveInvitation(payload: {
  title: string;
  description: string | null;
  location: string | null;
  startTime: number;
  endTime: number;
  allDay: boolean;
  rrule: string | null;
  status: CalendarEvent['status'];
  data: EventData;
  createByUserId: string;
  organizerEventId: string;
  organizerUserId: string;
}): string
```

Find default calendar via `this.getCalendars().find(c => c.isDefault)`, check existing via `findLinkedEvent`,
insert with `organizerEventId`/`organizerUserId` columns set.

### `receiveInvitationUpdate(orgEventId: string, orgUserId: string, payload): void`

Updates existing linked event. **Preserves** attendee's local `data.reminders` and `data.color`. Only updates:
title, description, location, times, rrule, status, `data.attendees`.

### `removeInvitation(orgEventId: string, orgUserId: string): void`

Finds linked event via `findLinkedEvent`, deletes it. No-op if not found.

### `updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): void`

Atomic read-modify-write using `db.transaction()` to prevent concurrent RSVPs from clobbering each other:

```typescript
updateAttendeeStatus(eventId
:
string, email
:
string, status
:
Attendee['status']
):
void {
  const db = this.db;
  db.transaction(() => {
    const event = this.getEventById(eventId);
    if (!event?.data?.attendees) return;

    const attendees = event.data.attendees.map(a =>
            a.email.toLowerCase() === email.toLowerCase() ? {...a, status} : a
    );

    db.update(schema.events).set({
      data: {...event.data, attendees},
      updatedAt: sql`unixepoch()`,
    }).where(eq(schema.events.id, eventId)).run();
  })();

  const updated = this.getEventById(eventId);
  if(updated) this.incrementCtag(updated.calendarId);
}
```

### `getEventsWithAttendee(email: string): CalendarEvent[]`

For reconciliation only (runs once at signup). Scans all non-linked (organizer) events for this attendee email:

```typescript
getEventsWithAttendee(email
:
string
):
CalendarEvent[]
{
  const rows = this.db.select().from(schema.events).where(
          isNull(schema.events.organizerEventId)
  ).all();

  return rows
          .map(dbEventToCalendarEvent)
          .filter(e => e.data?.attendees?.some(
                  a => a.email.toLowerCase() === email.toLowerCase()
          ));
}
```

---

## Invite Propagation (`apps/api/src/lib/calendar/invite-propagation.ts`)

**New file.** Follows `share-propagation.ts` pattern: async functions calling `getHome()` + `getUserByEmail()`,
per-attendee try/catch for error isolation.

### `propagateInvitation(organizerHome, event, user, oldAttendees, newAttendees)`

- `user` is the authenticated user from the route — provides `user.email` for `organizer.email`
  (**never** use `home.user.email`, which is `''` for team calendars)
- Diffs old vs new attendees by email
- **Added:** resolve email → userId, `receiveInvitation()`, emit `CALENDAR_INVITE_RECEIVED` SSE
- **Removed:** resolve email → userId, `removeInvitation()`, emit `CALENDAR_INVITE_CANCELLED` SSE
- **Existing:** `receiveInvitationUpdate()` to sync changes, emit `CALENDAR_INVITE_UPDATED` SSE
- **Unresolved:** `addRegistryEntry(organizerHome.user.id, email)` for future reconciliation
- Self-invite prevention: skip attendee matching organizer's email

### `propagateRsvp(organizerUserId, organizerEventId, attendeeEmail, newStatus)`

`getHome(organizerUserId)` → `calendar.updateAttendeeStatus()` (atomic) → emit `CALENDAR_INVITE_RSVP` SSE.

### `propagateCancellation(organizerHome, event)`

For each attendee: resolve → `removeInvitation()` + `CALENDAR_INVITE_CANCELLED` SSE.

### `propagateDecline(organizerUserId, organizerEventId, attendeeEmail)`

`getHome(organizerUserId)` → `calendar.updateAttendeeStatus(…, 'declined')` → `CALENDAR_INVITE_RSVP` SSE.

---

## SSE Events

### New types (`packages/lib/src/types/sse.ts`)

```typescript
CALENDAR_INVITE_RECEIVED: 'calendar:invite-received',
CALENDAR_INVITE_UPDATED: 'calendar:invite-updated',
CALENDAR_INVITE_CANCELLED: 'calendar:invite-cancelled',
CALENDAR_INVITE_RSVP: 'calendar:invite-rsvp',
```

Add to `SSEventCalendarNotification` type union and `CalendarEventType` in `sse-events.ts`. Reuse existing
`SSEventCalendarData` payload (`{ calendarId, eventId?, title? }`).

### Templates (`apps/api/src/lib/calendar/sse-events.ts`)

```typescript
[SSEventType.CALENDAR_INVITE_RECEIVED]: {
    title: 'Event invitation',
    body: (d) => d.title ? `You've been invited to "${d.title}"` : 'You have a new invitation',
},
[SSEventType.CALENDAR_INVITE_UPDATED]: {
    title: 'Event updated',
    body: (d) => d.title ? `"${d.title}" has been updated` : 'An event you attend was updated',
},
[SSEventType.CALENDAR_INVITE_CANCELLED]: {
    title: 'Event cancelled',
    body: (d) => d.title ? `"${d.title}" was cancelled` : 'An event was cancelled',
},
[SSEventType.CALENDAR_INVITE_RSVP]: {
    title: 'RSVP received',
    body: (d) => d.title ? `RSVP received for "${d.title}"` : 'An attendee responded',
},
```

Sent via `targetHome.notify()` — NOT via `notifySharedCalendarUsers()`.

---

## Route Changes (`apps/api/src/routes/calendar.ts`)

### Create event (modify existing)

After `calendar.createEvent()`, if `data?.attendees` is non-empty:

```typescript
.
post("/calendar/:ownerId/calendars/:calId/events", async ({params, body, user}) => {
  const {calendar, permission} = await resolveCalendarForEvents(user, params.ownerId, params.calId);
  if (permission !== 'write') throw new ApiError(403, 'Write permission required');

  const event = calendar.createEvent(params.calId, {...body, createByUserId: user.id});

  if (event.data?.attendees?.length) {
    const organizerHome = await getHome(params.ownerId);
    propagateInvitation(organizerHome, event, user, [], event.data.attendees).catch(console.error);
  }

  return event;
}, {body: CreateEventSchema, auth: true})
```

### Update event (modify existing)

Read old event before update, diff attendees. Only propagate if organizer copy (no `data.organizer`):

```typescript
.
put("/calendar/:ownerId/calendars/:calId/events/:id", async ({params, body, user}) => {
  const {calendar, permission} = await resolveCalendarForEvents(user, params.ownerId, params.calId);
  if (permission !== 'write') throw new ApiError(403, 'Write permission required');

  const oldEvent = calendar.getEventById(params.id);
  const updated = calendar.updateEvent(params.id, body);

  if (!oldEvent?.data?.organizer && updated.data?.attendees?.length) {
    const organizerHome = await getHome(params.ownerId);
    propagateInvitation(
            organizerHome, updated, user,
            oldEvent?.data?.attendees || [],
            updated.data.attendees
    ).catch(console.error);
  }

  return updated;
}, {body: UpdateEventSchema, auth: true})
```

### Delete event (modify existing)

Detect organizer vs attendee copy:

```typescript
.
delete("/calendar/:ownerId/calendars/:calId/events/:id", async ({params, user}) => {
  const {calendar, permission} = await resolveCalendarForEvents(user, params.ownerId, params.calId);
  if (permission !== 'write') throw new ApiError(403, 'Write permission required');

  const event = calendar.getEventById(params.id);

  if (event?.data?.organizer) {
    propagateDecline(
            event.data.organizer.userId,
            event.data.organizerEventId!,
            user.email
    ).catch(console.error);
  } else if (event?.data?.attendees?.length) {
    const organizerHome = await getHome(params.ownerId);
    propagateCancellation(organizerHome, event).catch(console.error);
  }

  calendar.deleteEvent(params.id);
  return {success: true};
}, {auth: true})
```

### RSVP (new endpoint)

```typescript
.
put("/calendar/:ownerId/calendars/:calId/events/:eventId/rsvp", async ({params, body, user}) => {
  if (params.ownerId !== user.id) throw new ApiError(403, 'Forbidden');

  const home = await getHome(user.id);
  const event = home.calendar.getEventById(params.eventId);
  if (!event) throw new ApiError(404, 'Event not found');
  if (!event.data?.organizer) throw new ApiError(400, 'Not a linked event');

  const isAttendee = event.data.attendees?.some(
          a => a.email.toLowerCase() === user.email.toLowerCase()
  );
  if (!isAttendee) throw new ApiError(403, 'Not an attendee');

  home.calendar.updateAttendeeStatus(params.eventId, user.email, body.status);

  propagateRsvp(
          event.data.organizer.userId,
          event.data.organizerEventId!,
          user.email,
          body.status
  ).catch(console.error);

  return {success: true};
}, {
  body: t.Object({
    status: t.Union([t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
  }),
  auth: true
})
```

---

## Reconciliation (`apps/api/src/lib/share/reconciliation.ts`)

Add `pullPendingInvitations()` alongside existing `pullCalendarShares()` and `pullDriveShares()`:

```typescript
async function pullPendingInvitations(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    userEmail: string,
): Promise<void> {
  const events = ownerHome.calendar.getEventsWithAttendee(userEmail);
  for (const event of events) {
    targetHome.calendar.receiveInvitation({
      title: event.title, description: event.description,
      location: event.location, startTime: event.startTime,
      endTime: event.endTime, allDay: event.allDay,
      rrule: event.rrule, status: event.status,
      data: {
        organizer: {userId: ownerHome.user.id, email: ownerHome.user.email},
        organizerEventId: event.id,
        attendees: event.data?.attendees,
      },
      createByUserId: ownerHome.user.id,
      organizerEventId: event.id,
      organizerUserId: ownerHome.user.id,
    });
  }
}
```

Call from `reconcileSharesForNewUser()`:

```typescript
await pullCalendarShares(ownerHome, targetHome, user.email, []);
await pullDriveShares(ownerHome, targetHome, user);
await pullPendingInvitations(ownerHome, targetHome, user.email);  // NEW
```

Process organizers sequentially (not `Promise.all`) to avoid mass Home initialization.

---

## Recurring Event Invitations

- Attendee receives a single linked recurring event (not individual occurrences)
- Organizer creates exception (edits one occurrence): propagate exception to all attendees. Attendee's exception
  uses their linked event's ID as `parentEventId` (not organizer's event ID)
- Organizer cancels one occurrence: propagate cancellation exception to all attendees
- Attendee RSVPs on single occurrence: create exception on their copy + propagate status for that `recurrenceDate`
  back to organizer's exception (creating one on organizer's side if needed)
- `findLinkedEvent` must also check exceptions (`parentEventId` set) when propagating occurrence-level changes

---

## Frontend

### Attendee picker (`create-event-dialog.tsx` + `edit-event-dialog.tsx`)

Reuse `ContactAutosuggest` from `@workspace/ui/components/layout/contacts/contact-autosuggest` (already used in
`calendar-share-editor.tsx`). Email input + autocomplete. Added attendees list with role toggle + remove button.
On edit: show RSVP status badge per attendee. Wire into `data.attendees` on create/update mutation.

`CreateEventInput`/`UpdateEventInput` already include `data?: EventData | null` — no type changes needed.

### RSVP UI (`event-detail-dialog.tsx`)

For linked events (`event.data?.organizer` set): show RSVP bar with Accept/Tentative/Decline buttons. Current
selection highlighted. Show attendee list with status icons. Use `useRsvp()` hook.

### Visual indicators (`month-view.tsx` + `week-view.tsx`)

Pending invitations: dashed border. Declined: dimmed. Detection: `event.data?.organizer` + find current user's
status in `event.data?.attendees`.

### `useRsvp` hook (`packages/lib/src/core/calendar/hooks/use-calendar.ts`)

```typescript
export function useRsvp(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({calendarId, eventId, status}: {
          calendarId: string; eventId: string;
          status: 'accepted' | 'declined' | 'tentative';
        }) => {
          // TODO: regenerate Treaty types after RSVP endpoint is added
            const response = await (calendarApi({ownerId}).calendars as any)
                ({calId: calendarId}).events({id: eventId}).rsvp.put({status});
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient),
    });
}
```

### SSE handlers (`packages/lib/src/core/calendar/sse-handlers.ts`)

Add four cases to `handleCalendarSSEvent`:

- `CALENDAR_INVITE_RECEIVED` → `invalidateEventCreated(queryClient)`
- `CALENDAR_INVITE_UPDATED` → `invalidateEventUpdated(queryClient)`
- `CALENDAR_INVITE_CANCELLED` → `invalidateEventDeleted(queryClient)`
- `CALENDAR_INVITE_RSVP` → `invalidateEventUpdated(queryClient)`

Toasts come automatically from SSEProvider (`isSSEventNotification()` matches events with `body`).

---

## Implementation Steps

### Step 1: Types + SSE infrastructure

| File                                      | Change                                                    |
|-------------------------------------------|-----------------------------------------------------------|
| `apps/api/src/lib/calendar/schema.ts`     | Add `organizerEventId`, `organizerUserId` columns + index |
| `apps/api/src/routes/calendar.ts`         | Add `AttendeeSchema` to `EventDataSchema`                 |
| `packages/lib/src/types/sse.ts`           | Add 4 new SSE event type constants + extend type union    |
| `apps/api/src/lib/calendar/sse-events.ts` | Add 4 template entries + extend `CalendarEventType` union |

### Step 2: Calendar class methods

| File                                    | Change                                                                                                                                                 |
|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/calendar/calendar.ts` | Add `findLinkedEvent()`, `receiveInvitation()`, `receiveInvitationUpdate()`, `removeInvitation()`, `updateAttendeeStatus()`, `getEventsWithAttendee()` |

### Step 3: Propagation + routes

| File                                              | Change                                                                                               |
|---------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/calendar/invite-propagation.ts` | **New.** `propagateInvitation()`, `propagateRsvp()`, `propagateCancellation()`, `propagateDecline()` |
| `apps/api/src/routes/calendar.ts`                 | Wire propagation into create/update/delete handlers; add RSVP endpoint                               |
| `apps/api/src/lib/share/reconciliation.ts`        | Add `pullPendingInvitations()`, call from `reconcileSharesForNewUser()`                              |

### Step 4: Frontend — dialogs + hooks

| File                                                   | Change                                |
|--------------------------------------------------------|---------------------------------------|
| `apps/calendar/src/components/create-event-dialog.tsx` | Attendee picker UI                    |
| `apps/calendar/src/components/edit-event-dialog.tsx`   | Attendee picker + RSVP status display |
| `packages/lib/src/core/calendar/hooks/use-calendar.ts` | Add `useRsvp()` hook                  |

### Step 5: Frontend — RSVP + display

| File                                                   | Change                                         |
|--------------------------------------------------------|------------------------------------------------|
| `apps/calendar/src/components/event-detail-dialog.tsx` | Attendee list + RSVP buttons for linked events |
| `apps/calendar/src/components/month-view.tsx`          | Invitation visual indicators                   |
| `apps/calendar/src/components/week-view.tsx`           | Invitation visual indicators                   |
| `packages/lib/src/core/calendar/sse-handlers.ts`       | Handle 4 new SSE types                         |

### Step 6: Tests

| File                                         | Coverage                                                                                                                                                |
|----------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/test/calendar-invites.test.ts` | Full invite flow, RSVP propagation, update propagation, cancellation, attendee removal, recurring exceptions, self-invite skip, registry reconciliation |

Follow existing test patterns: `authedRequest()` + `getTestContext()` from `setup.ts` (Alice, Bob, Charlie).

---

## Edge Cases

| Case                                 | Behavior                                                                                                                                           |
|--------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| **Self-invite**                      | Skip: match organizer email against attendee list before propagating                                                                               |
| **Unknown email**                    | `addRegistryEntry()`. On signup, `pullPendingInvitations()` creates linked copies                                                                  |
| **Team calendar event**              | Works same — team event is organizer copy. Use `user.email` (not team home email) for organizer identity                                           |
| **Attendee has no default calendar** | Impossible: `Calendar.init()` always creates one                                                                                                   |
| **Organizer deletes account**        | Linked events orphaned. RSVP fails with 404 from `getHome()`. Acceptable during dev                                                                |
| **Attendee removes linked copy**     | Treated as decline via `propagateDecline()`                                                                                                        |
| **Calendar move**                    | Handled automatically: delete→create triggers cancel→reinvite. No special case                                                                     |
| **Concurrent RSVPs**                 | `updateAttendeeStatus()` uses `db.transaction()` — serialized                                                                                      |
| **Recurring + attendees**            | Linked copy is single recurring event. Occurrence exceptions propagated individually. Exception uses attendee's linked event ID as `parentEventId` |
| **Shared-calendar attendee**         | Gets linked copy AND sees via sharing. Coexist; known UX gap, defer                                                                                |
| **Many attendees**                   | O(n) `getHome()` calls. `Promise.allSettled()` with per-attendee try/catch. Fine for < 100 users                                                   |
| **Attendee offline**                 | Linked event written to their SQLite directly. Visible on next load                                                                                |

---

## Design Decisions

| Decision                                                       | Rationale                                                                                                                                                                   |
|----------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Indexed `organizerEventId`/`organizerUserId` columns**       | `findLinkedEvent` runs on every update/delete/RSVP. JSON queries = O(n) full scan. Indexed columns = O(1).                                                                  |
| **`organizer`/`organizerEventId` NOT in route validation**     | Security: existing `EventDataSchema` already blocks them. Server-only fields set by `receiveInvitation()`. No client forgery possible.                                      |
| **Always `user.email` for organizer, never `home.user.email`** | TeamHome has `email: ''`. Authenticated user always has real email. Pass `user` from route handler to propagation.                                                          |
| **Snapshot `data.attendees` in linked copies**                 | Don't propagate peer RSVP updates to other attendees' copies. Avoids O(n²) fan-out. Each attendee sees their own status accurately; peer status is snapshot-at-invite-time. |
| **`db.transaction()` for RSVP updates**                        | Prevents concurrent RSVPs from clobbering via read-modify-write race. SQLite serializes transactions.                                                                       |
| **Calendar move = delete + create**                            | Existing edit dialog already does this. Delete → `propagateCancellation`, Create → `propagateInvitation`. No special case.                                                  |
| **Sequential reconciliation**                                  | Process organizers one-by-one in `pullPendingInvitations`, not `Promise.all`, to avoid mass Home initialization.                                                            |
| **Shared-calendar + linked copy coexist**                      | Attendee who also has shared access sees the event twice. Known UX gap, defer to a later improvement.                                                                       |

---

## Future: External/Guest Invites

See `docs/TODO-GUEST-USERS.md` for the guest user system.

**How Google/Microsoft handle external invites:**

- Google Calendar: iMIP email with ICS attachment. External user clicks accept/decline in email.
- Outlook: meeting request to inbox. External user's mail client processes ICS.

**Eigen's future path:**

1. Organizer adds unregistered email → `addRegistryEntry()` (already handled by this plan)
2. If that email signs up as a guest via OTP → `reconcileSharesForNewUser()` runs →
   `pullPendingInvitations()` creates linked copies automatically
3. **Optional next step:** Send notification email to unresolved emails with a link to Eigen
   (requires email sending infrastructure, not in scope)
4. **Later:** iMIP email interop (ICS attachments) for external calendar systems

No code changes needed for guest support — the registry + reconciliation pattern already handles deferred resolution.

---

## File Inventory

### New

- `apps/api/src/lib/calendar/invite-propagation.ts`
- `apps/api/src/test/calendar-invites.test.ts`

### Modified — backend

- `apps/api/src/lib/calendar/schema.ts` — add `organizerEventId`, `organizerUserId` columns + index
- `apps/api/src/lib/calendar/calendar.ts` — add 6 new methods
- `apps/api/src/routes/calendar.ts` — extend `EventDataSchema`, modify create/update/delete handlers, add RSVP endpoint
- `apps/api/src/lib/calendar/sse-events.ts` — add 4 templates, extend type union
- `apps/api/src/lib/share/reconciliation.ts` — add `pullPendingInvitations()`

### Modified — shared types

- `packages/lib/src/types/sse.ts` — add 4 event types to `SSEventType` + type union

### Modified — frontend
- `packages/lib/src/core/calendar/hooks/use-calendar.ts` — add `useRsvp()` hook
- `packages/lib/src/core/calendar/sse-handlers.ts` — handle 4 new SSE types
- `apps/calendar/src/components/create-event-dialog.tsx` — attendee picker
- `apps/calendar/src/components/edit-event-dialog.tsx` — attendee picker + status display
- `apps/calendar/src/components/event-detail-dialog.tsx` — attendee list + RSVP buttons
- `apps/calendar/src/components/month-view.tsx` — visual indicators
- `apps/calendar/src/components/week-view.tsx` — visual indicators

### No changes needed

- `packages/lib/src/types/calendar.ts` — types already defined
