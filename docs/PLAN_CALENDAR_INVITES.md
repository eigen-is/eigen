# Plan: Calendar Event Invites

## Background

Eigen's calendar already has per-user SQLite databases, push-based calendar sharing, SSE real-time updates, and team
calendar support. The `EventData` type in `packages/lib/src/types/calendar.ts` already declares `attendees`, `organizer`,
and `organizerEventId` fields (added during original schema design), and the `data` JSON column in the events table can
store them. However, nothing populates or reads them yet, and the Elysia route validation schema (`EventDataSchema` in
`apps/api/src/routes/calendar.ts`) does not include these fields — it must be extended. This plan adds the ability to
invite other Eigen users to calendar events with RSVP tracking.

### Prior Design (recovered from git, commit 1bccf95)

The original CALENDAR.md Section 7 described:

- All users share one Eigen instance → server-side propagation, no iMIP emails needed
- Organizer creates event with attendees → system writes **linked event** to each attendee's default calendar
  via `getHome(attendeeId)` → `calendar.receiveInvitation(event)`
- Linked event stores `organizer.userId` + `organizerEventId` pointing back to the original
- Attendee RSVPs → updates their local copy → propagates status back to organizer's attendee list
- Organizer updates event → propagates changes to all attendee copies
- Future: iMIP over email for external users can be layered on top

This plan follows that design with concrete implementation details.

---

## Data Model

### Existing types in `packages/lib/src/types/calendar.ts` (no changes needed)

```typescript
type Attendee = {
    email: string
    status: 'pending' | 'accepted' | 'declined' | 'tentative'
    role: 'required' | 'optional'
}

type EventData = {
    reminders?: Reminder[]
    attendees?: Attendee[]
    organizer?: { userId: string; email: string }
    organizerEventId?: string
    url?: string
    notes?: string
    color?: string
}
```

### Route validation schema change required

The `EventDataSchema` in `apps/api/src/routes/calendar.ts` currently only validates `reminders`, `url`, `notes`, and
`color`. It must be extended to also accept `attendees`, `organizer`, and `organizerEventId`:

```typescript
const AttendeeSchema = t.Object({
    email: t.String(),
    status: t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('declined'), t.Literal('tentative')]),
    role: t.Union([t.Literal('required'), t.Literal('optional')]),
});

const EventDataSchema = t.Object({
    reminders: t.Optional(t.Array(ReminderSchema)),
    attendees: t.Optional(t.Array(AttendeeSchema)),
    organizer: t.Optional(t.Object({
        userId: t.String(),
        email: t.String(),
    })),
    organizerEventId: t.Optional(t.String()),
    url: t.Optional(t.String()),
    notes: t.Optional(t.String()),
    color: t.Optional(t.String()),
});
```

Without this change, any `data.attendees` sent from the frontend will be silently stripped by Elysia's validation.

### How linked events work

When organizer creates/updates an event with attendees:

1. **Organizer's event** stores `data.attendees[]` with each invitee's email + status
2. **Each attendee** gets a **linked copy** in their default calendar with:
    - Same title, description, location, times, rrule
    - `data.organizer = { userId: organizer.id, email: organizer.email }`
    - `data.organizerEventId = organizer's event ID`
    - `data.attendees` = same array (so attendee can see who else is invited)
    - `createByUserId = organizer's user ID` (passed through to `Calendar.createEvent`)
3. Linked events are regular events in the attendee's DB — they show up in normal queries

### Identifying linked events

An event is a linked (attendee) copy if `data.organizer` is set. The organizer's copy is the source of truth — it has
`data.attendees[]` but no `data.organizer`. This distinction drives all permission logic.

### Finding linked events (JSON query)

Since `organizerEventId` and `organizer.userId` are inside the JSON `data` column, `findLinkedEvent()` must use a SQLite
JSON query. Drizzle supports this via `sql` template literals:

```typescript
sql`json_extract(${schema.events.data}, '$.organizerEventId') = ${organizerEventId}
    AND json_extract(${schema.events.data}, '$.organizer.userId') = ${organizerUserId}`
```

Consider adding a dedicated indexed column (e.g., `organizerEventId TEXT`) to the events table if JSON queries prove too
slow with many events. Since data is throwaway during dev, adding a column is low-cost.

### Finding the default calendar

There is no `getDefaultCalendar()` method on the Calendar class. To find the attendee's default calendar for writing
linked events, use:

```typescript
const defaultCal = calendar.getCalendars().find(c => c.isDefault);
```

Every user's calendar is auto-initialized with a default calendar in `Calendar.init()`, so this will always return a
result for initialized Homes.

---

## API Changes

### New endpoint: RSVP

```
PUT /calendar/:ownerId/calendars/:calId/events/:eventId/rsvp
Body: { status: 'accepted' | 'declined' | 'tentative' }
```

- Validates caller is an attendee of this event (matched by `user.email`)
- Updates `data.attendees[].status` on the **attendee's local copy**
- Propagates status back to **organizer's copy** via `getHome(data.organizer.userId)`
- Emits SSE to organizer: `CALENDAR_INVITE_RSVP`

Note: the `ownerId` here is the attendee's own userId (they're RSVPing on their local copy). The organizer's
identity comes from `event.data.organizer.userId`.

### Modified: Create event

`POST /calendar/:ownerId/calendars/:calId/events`

After creating the organizer's event, if `data.attendees[]` is non-empty:

1. Resolve each attendee email → userId via `getUserByEmail()` (from `apps/api/src/lib/user/user.ts`)
2. Skip the organizer's own email (self-invite prevention)
3. For each resolved attendee: `getHome(userId)` → `home.calendar.receiveInvitation(payload)`
4. Emit `CALENDAR_INVITE_RECEIVED` SSE to each attendee via `attendeeHome.notify()`
5. Unresolved emails: `addRegistryEntry(organizerUserId, email)` for future reconciliation

The route handler has access to the `user` object (from `{auth: true}`), which provides the organizer's identity.
The propagation function receives the organizer's Home from `getHome(ownerId)` at the route level, not from the
Calendar class (Calendar.home is private).

### Modified: Update event

`PUT /calendar/:ownerId/calendars/:calId/events/:eventId`

If the event has attendees (organizer's copy — i.e., `data.organizer` is NOT set):

1. Read old event before applying update to diff attendees
2. Diff old vs new attendees list (by email)
3. **Added attendees**: resolve + `receiveInvitation()` + SSE
4. **Removed attendees**: resolve + `removeInvitation()` + SSE (`CALENDAR_INVITE_CANCELLED`)
5. **Existing attendees**: `receiveInvitationUpdate()` to sync title/time/location changes
6. Preserve each attendee's existing RSVP status (don't reset on update)

Special case: if an attendee edits their own linked copy's non-organizer fields (personal reminders, color), those
local changes should not be overwritten by organizer updates. `receiveInvitationUpdate()` should only update
title, description, location, times, rrule, and `data.attendees` — not `data.reminders` or `data.color`.

### Modified: Delete event

`DELETE /calendar/:ownerId/calendars/:calId/events/:eventId`

If organizer's copy with attendees (no `data.organizer` set):

1. For each attendee: `removeInvitation()` → deletes their linked copy
2. Emit `CALENDAR_INVITE_CANCELLED` SSE to each attendee

If attendee deletes their linked copy (`data.organizer` IS set):

1. Propagate `declined` status to organizer's `data.attendees[].status` via `getHome(data.organizer.userId)`
2. Emit `CALENDAR_INVITE_RSVP` SSE to organizer

---

## Backend Implementation

### Calendar class additions (`apps/api/src/lib/calendar/calendar.ts`)

New methods on the `Calendar` class. These operate on the Calendar instance of the **attendee's** Home (except
`findLinkedEvent` which is called on the attendee's calendar to look up their local copy):

```typescript
// Receive an invitation — create linked event in attendee's default calendar
// Returns the created event's ID
receiveInvitation(payload: {
    title: string
    description: string | null
    location: string | null
    startTime: number
    endTime: number
    allDay: boolean
    rrule: string | null
    status: CalendarEvent['status']
    data: EventData
    createByUserId: string
}): string

// Update an existing linked event when organizer changes details
// Preserves attendee's local data.reminders and data.color
receiveInvitationUpdate(organizerEventId: string, organizerUserId: string, payload: {
    title: string
    description: string | null
    location: string | null
    startTime: number
    endTime: number
    allDay: boolean
    rrule: string | null
    status: CalendarEvent['status']
    attendees: Attendee[]
}): void

// Remove a linked event when organizer cancels or removes attendee
removeInvitation(organizerEventId: string, organizerUserId: string): void

// Find linked event by organizer reference (JSON query on data column)
findLinkedEvent(organizerEventId: string, organizerUserId: string): CalendarEvent | null
```

These methods are synchronous (no async) because they only access the local SQLite DB (like the existing `createEvent`,
`updateEvent`, `deleteEvent` methods). The `home` field is private, so these methods use `this.db` directly.

### Invitation propagation (`apps/api/src/lib/calendar/invite-propagation.ts`)

New file, follows the pattern of `share-propagation.ts`. Functions are `async` because they call `getHome()` and
`getUserByEmail()` which are async:

```typescript
import type {Home} from '../home'
import type {Attendee, CalendarEvent} from '@workspace/lib/types/calendar'
import type {SSEvent} from '@workspace/lib/types/sse'
import {getHome} from '../home'
import {getUserByEmail} from '../user'
import {addRegistryEntry} from '../share'

// Push invitation to all attendees after create or update
// Diffs old vs new attendee lists to determine adds/removes/updates
async function propagateInvitation(
    organizerHome: Home,
    event: CalendarEvent,
    oldAttendees: Attendee[],
    newAttendees: Attendee[]
): Promise<void>

// Propagate RSVP status change back to organizer
// Called from the RSVP endpoint
async function propagateRsvp(
    organizerUserId: string,
    organizerEventId: string,
    attendeeEmail: string,
    newStatus: Attendee['status']
): Promise<void>

// Propagate event deletion/cancellation to all attendees
// Called from the delete endpoint when organizer deletes
async function propagateCancellation(
    organizerHome: Home,
    event: CalendarEvent
): Promise<void>

// Propagate attendee-declined (when attendee deletes their linked copy)
async function propagateDecline(
    organizerUserId: string,
    organizerEventId: string,
    attendeeEmail: string
): Promise<void>
```

Important: each propagation function must wrap per-attendee operations in try/catch (like `share-propagation.ts` does)
to prevent one attendee's failure from blocking others. Log errors with `console.error`.

### SSE events (`apps/api/src/lib/calendar/sse-events.ts`)

New event types to add to `SSEventType` in `packages/lib/src/types/sse.ts`:

```typescript
CALENDAR_INVITE_RECEIVED: 'calendar:invite-received',
CALENDAR_INVITE_UPDATED: 'calendar:invite-updated',
CALENDAR_INVITE_CANCELLED: 'calendar:invite-cancelled',
CALENDAR_INVITE_RSVP: 'calendar:invite-rsvp',
```

These reuse the existing `SSEventCalendarData` payload shape (`{ calendarId, eventId?, title? }`), which is sufficient
for cache invalidation. The frontend handler only needs to invalidate `calendarKeys.events()`.

New event types must also be added to the `SSEventCalendarNotification` type union in `packages/lib/src/types/sse.ts`
and to the `CalendarEventType` union in `apps/api/src/lib/calendar/sse-events.ts`. Add corresponding template entries
in the `calendarTemplates` record.

New builder entries in `sse-events.ts`:

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

Invite SSE events are sent to the attendee or organizer via `targetHome.notify(event)` — not via
`notifySharedCalendarUsers()` (which is for calendar-level sharing, not event invites).

### Recurring event invitations

When organizer has a recurring event with attendees:

- Attendee receives a single linked recurring event (not individual occurrences)
- If organizer creates an exception (edit one occurrence): propagate exception to all attendees.
  The attendee's exception uses their linked event's ID as `parentEventId` (not the organizer's event ID).
- If organizer cancels one occurrence: propagate cancellation exception to all attendees
- Attendee RSVP on a single occurrence: create an exception on their copy + propagate status for that date
  back to the organizer's exception (creating one on the organizer's side if needed)
- The `recurrenceDate` field on exceptions links them to specific occurrences

For recurring exceptions, `findLinkedEvent` must also check exceptions (events with `parentEventId` set) to find
the correct linked exception to update. This requires checking both the parent linked event and its children.

### Share registry integration

Reuse existing `addRegistryEntry()` / reconciliation for unresolved attendee emails:

- On event create/update with unknown email: `addRegistryEntry(organizerUserId, email)` (from
  `apps/api/src/lib/share/registry.ts`)
- When new user signs up: `reconcileSharesForNewUser()` in `apps/api/src/lib/share/reconciliation.ts` already
  processes registry entries. Currently it only calls `pullCalendarShares()` and `pullDriveShares()`. Add a new
  `pullPendingInvitations()` function:

```typescript
async function pullPendingInvitations(
    ownerHome: Awaited<ReturnType<typeof getHome>>,
    targetHome: Awaited<ReturnType<typeof getHome>>,
    userEmail: string,
): Promise<void>
```

This function scans the organizer's calendars for events where `data.attendees[].email` matches the new user's email
(a full-table scan on the JSON column). Since reconciliation happens once at signup, performance is acceptable. For
each matching event, call `targetHome.calendar.receiveInvitation(...)`.

---

## Frontend Implementation

### Event create/edit dialog changes

**Attendee picker** (new section in `create-event-dialog.tsx` and `edit-event-dialog.tsx`):

- Reuse `ContactAutosuggest` from `@workspace/ui/components/layout/contacts/contact-autosuggest` (already used in
  `apps/calendar/src/components/calendar-share-editor.tsx` for calendar sharing)
- Email input with autocomplete from contacts
- List of added attendees with role toggle (required/optional) and remove button
- On edit: show current RSVP status next to each attendee (color-coded badge)
- Wire the attendees array into `data.attendees` when calling the create/update mutation

Note: the `CreateEventInput` and `UpdateEventInput` types in `packages/lib/src/types/calendar.ts` already include
`data?: EventData | null`, so no type changes are needed for the input types.

### Event detail dialog changes

**Attendee list** (in `event-detail-dialog.tsx`):

- Show attendees with their RSVP status icons/badges
- For linked events (attendee view, detected by `event.data?.organizer` being set): show RSVP buttons
- For organizer view: read-only status display
- Show organizer name using the existing `UserName` component (already imported in this file)

### RSVP UI

**Inline RSVP bar** — shown at top of event detail for linked events:

- Three buttons: Accept, Tentative, Decline
- Current selection highlighted
- Calls `useRsvp()` hook which hits `PUT .../rsvp` endpoint

**Calendar view indicators** — in `month-view.tsx` and `week-view.tsx`:

- Pending invitations: dashed border or subtle visual indicator
- Declined events: dimmed or struck through (or hidden based on user preference)
- Detection: check `event.data?.organizer` (is linked) and `event.data?.attendees` to find current user's status

### New hooks

Add to `packages/lib/src/core/calendar/hooks/use-calendar.ts` (per project rules: never use `useQuery`/`useMutation`
directly in apps):

```typescript
export function useRsvp(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({calendarId, eventId, status}: {
            calendarId: string
            eventId: string
            status: 'accepted' | 'declined' | 'tentative'
        }) => {
            const response = await (calendarApi({ownerId}).calendars as any)
                ({calId: calendarId}).events({id: eventId}).rsvp.put({status});
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient),
    });
}
```

### SSE handler updates

Add cases in `handleCalendarSSEvent` (in `packages/lib/src/core/calendar/sse-handlers.ts`) for the new event types.
The handler uses a `switch` on `event.type` — add four new cases:

- `CALENDAR_INVITE_RECEIVED` → `invalidateEventCreated(queryClient)` (toast comes from SSEProvider automatically
  since these events have `body`)
- `CALENDAR_INVITE_UPDATED` → `invalidateEventUpdated(queryClient)`
- `CALENDAR_INVITE_CANCELLED` → `invalidateEventDeleted(queryClient)`
- `CALENDAR_INVITE_RSVP` → `invalidateEventUpdated(queryClient)`

The SSEProvider in `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` already shows toasts for any
event with a `body` field (via `isSSEventNotification()`), so no toast code is needed in the handler.

---

## Implementation Order

### Step 1: Route validation + SSE types

1. Extend `EventDataSchema` in `apps/api/src/routes/calendar.ts` to include `attendees`, `organizer`,
   `organizerEventId` (this unblocks frontend work)
2. Add new SSE event type constants to `packages/lib/src/types/sse.ts` (`SSEventType` object + type union)
3. Add SSE builder templates to `apps/api/src/lib/calendar/sse-events.ts`

### Step 2: Backend core — Calendar class methods

1. Add `findLinkedEvent()` to Calendar class (JSON query on data column)
2. Add `receiveInvitation()` — creates linked event in default calendar
3. Add `receiveInvitationUpdate()` — updates existing linked event, preserving local fields
4. Add `removeInvitation()` — deletes linked event

### Step 3: Backend propagation + routes

1. Create `apps/api/src/lib/calendar/invite-propagation.ts` with `propagateInvitation()`, `propagateRsvp()`,
   `propagateCancellation()`, `propagateDecline()`
2. Modify `POST .../events` route to call `propagateInvitation()` after creating organizer event
3. Modify `PUT .../events/:id` route: read old event first, diff attendees, propagate changes
4. Modify `DELETE .../events/:id` route: if organizer copy, call `propagateCancellation()`;
   if attendee copy, call `propagateDecline()`
5. Add `PUT .../events/:id/rsvp` route with `propagateRsvp()`
6. Extend `reconcileSharesForNewUser()` in `apps/api/src/lib/share/reconciliation.ts` to call
   `pullPendingInvitations()`

### Step 4: Frontend — attendee picker in dialogs

1. Add attendee picker UI to `create-event-dialog.tsx` (reuse `ContactAutosuggest`)
2. Add attendee picker UI to `edit-event-dialog.tsx` with status display
3. Add `useRsvp()` hook to `packages/lib/src/core/calendar/hooks/use-calendar.ts`
4. Wire attendee data into `data.attendees` for create/update mutations

### Step 5: Frontend — RSVP and display

1. Add RSVP buttons to `event-detail-dialog.tsx` for linked events (check `event.data?.organizer`)
2. Add attendee list display to `event-detail-dialog.tsx`
3. Add visual indicators in `month-view.tsx` and `week-view.tsx` for invitation status
4. Update SSE handler (`sse-handlers.ts`) for new event types

### Step 6: Tests

1. Integration tests: full invite flow (create event with attendees → attendee receives linked copy → RSVP →
   organizer sees updated status)
2. Integration tests: update propagation (organizer changes title → attendee's copy updates)
3. Integration tests: cancellation (organizer deletes → attendee's copy removed)
4. Integration tests: attendee removes linked copy → organizer sees declined
5. Integration tests: attendee removal (organizer removes one attendee → their copy is deleted)
6. Integration tests: recurring event invitations with exceptions
7. Edge case tests: self-invite skipped, unknown email stored in registry, duplicate invite is idempotent

Tests follow the project's existing pattern (see `apps/api/src/test/calendar.test.ts` and
`apps/api/src/test/team-calendar-share.test.ts`): use `authedRequest()` and `getTestContext()` from `setup.ts`,
which provides three test users (Alice, Bob, Charlie) with session tokens.

---

## Edge Cases

| Case | Behavior |
|------|----------|
| **Organizer invites themselves** | Skip — match organizer email against attendee list, don't create linked copy |
| **Unknown email** | `addRegistryEntry(organizerUserId, email)`. On signup, `reconcileSharesForNewUser()` scans organizer's events and creates linked copies |
| **Attendee has no default calendar** | Every user gets auto-created default calendar in `Calendar.init()` — always exists |
| **Organizer deletes account** | Linked events become orphaned (RSVP will fail with 404 from `getHome`). Leave as-is — data is throwaway during dev |
| **Team calendar event with attendees** | Works the same — team event is the organizer copy. However, `organizer.email` will be empty because `TeamHome` uses a synthetic user with `email: ''`. Set `organizer.email` to the actual creating user's email (from `user.email` in the route handler), not `home.user.email` |
| **Attendee removes linked event** | Treat as decline — `propagateDecline()` updates organizer's `data.attendees[].status` to `'declined'` |
| **Organizer changes calendar** | The existing edit-event-dialog handles calendar moves as delete + create. After move: propagate new `organizerEventId` to all attendees via `receiveInvitationUpdate()`, or simpler: treat as cancellation of old + new invitation |
| **Concurrent RSVP + organizer update** | Last-write-wins on attendee list. `propagateRsvp()` should re-read the organizer's event before writing to avoid clobbering a concurrent update. Use a read-modify-write pattern on the `data.attendees` array |
| **Recurring: RSVP on single occurrence** | Create exception on attendee's copy with `parentEventId` = attendee's linked event ID; propagate status for that `recurrenceDate` to organizer's exception |
| **Recurring: organizer edits one occurrence** | Create/update exception on organizer's copy, then propagate exception to all attendees. Each attendee's exception uses their own linked event's ID as `parentEventId` |
| **Shared calendar with write access** | Writer creates event with attendees → they become organizer (use `user.id` from the route, which is the actual user, not the calendar owner). Propagation uses their userId and email |
| **Attendee on shared calendar already sees event** | They still get a linked copy in their own calendar — shared view and personal copy coexist. The shared view shows the organizer's copy; the personal copy is the one they RSVP on |
| **Many attendees (fan-out)** | Propagation is O(n) `getHome()` calls. Each call may initialize a Home (DB open). Use `Promise.allSettled()` for parallelism, with per-attendee error isolation. For typical deployments (< 100 users) this is fine |
| **Attendee invited while offline** | Their linked event is written directly to their SQLite DB. They see it on next load. SSE notification is delivered if they reconnect before the Home times out (5 minutes) |

---

## Files to Create / Modify

### New files
- `apps/api/src/lib/calendar/invite-propagation.ts` — core propagation logic

### Modified files

**Backend:**
- `apps/api/src/routes/calendar.ts` — extend `EventDataSchema` with attendee/organizer fields, add RSVP endpoint,
  wire propagation into create/update/delete route handlers
- `apps/api/src/lib/calendar/calendar.ts` — add `receiveInvitation()`, `receiveInvitationUpdate()`,
  `removeInvitation()`, `findLinkedEvent()` methods
- `apps/api/src/lib/calendar/sse-events.ts` — add new invite SSE builder templates and extend `CalendarEventType`
  union
- `apps/api/src/lib/share/reconciliation.ts` — add `pullPendingInvitations()`, call it from
  `reconcileSharesForNewUser()`

**Shared types:**
- `packages/lib/src/types/sse.ts` — add four new event type constants to `SSEventType`, add them to the
  `SSEventCalendarNotification` type union

**Frontend hooks/handlers:**
- `packages/lib/src/core/calendar/hooks/use-calendar.ts` — add `useRsvp()` hook
- `packages/lib/src/core/calendar/sse-handlers.ts` — handle four new SSE event types

**Frontend UI:**
- `apps/calendar/src/components/create-event-dialog.tsx` — attendee picker section
- `apps/calendar/src/components/edit-event-dialog.tsx` — attendee picker with RSVP status display
- `apps/calendar/src/components/event-detail-dialog.tsx` — attendee list, RSVP buttons for linked events
- `apps/calendar/src/components/month-view.tsx` — invitation visual indicators
- `apps/calendar/src/components/week-view.tsx` — invitation visual indicators

**No changes needed:**
- `packages/lib/src/types/calendar.ts` — types already defined (`Attendee`, `EventData` with all fields,
  `CreateEventInput`/`UpdateEventInput` already include `data?: EventData`)
- `apps/api/src/lib/calendar/schema.ts` — `data` column already stores JSON, no schema migration needed

### Test files
- `apps/api/src/test/calendar-invites.test.ts` — integration tests for invite flow, RSVP, propagation, edge cases
