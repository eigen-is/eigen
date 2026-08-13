# Proposal: Importing External Calendars

> **TLDR**: Let users add external calendars in two flavours — a one-time `.ics` file import and a
> live URL subscription (Google public calendars, holiday feeds, conference schedules, sports
> calendars, etc.). Treat a subscription as a flavour of `Calendar`, not a separate entity: a row in
> the `calendars` table is either *owned* (writable, current behaviour) or *subscribed* (read-only,
> refreshed from a URL) based on a nullable `subscription` JSON column. Reuse `parseIcs()`
> (`apps/api/src/lib/caldav/ical-parse.ts`, already running for iMIP and CalDAV PUT) and the
> calendar DB's existing etag/ctag/tombstone conventions — but apply feed snapshots through one new
> bulk transaction, **not** by looping the public `createEvent`/`deleteEvent` (which would fire
> per-event SSE, per-event ctag bumps, and — dangerously — iMIP cancellation propagation for feed
> events that carry `ATTENDEE` lines). Refresh is on-access only (web reads, CalDAV reads, and a
> manual button) — no timers, no scheduler jobs. Subscribed calendars are strict read-only with
> `data.color`/`data.reminders` preserved as local overrides across refresh, matching Apple
> Calendar / Google Calendar / Outlook conventions. The SSRF decision (roadmap's one open decision)
> is made below: private-network feed URLs are **allowed by default** (self-hosted LAN feeds are
> legitimate — see the MinIO-on-LAN precedent), with an admin server-setting to lock them out on
> multi-tenant deployments. HTTP Basic auth and two-way CalDAV write-back are explicit non-goals.

Status: **not started** (verified against code 2026-07-06 — no subscription/import code exists
anywhere in `apps/api/src/lib/calendar/` or `apps/api/src/routes/calendar.ts`).

## Goals

1. Users can paste a `webcal://` or `https://…/feed.ics` URL and have the events appear in their
   calendar app, kept in sync automatically.
2. Users can upload an `.ics` file as a one-time import, either into an existing calendar or into a
   new one seeded from the file.
3. Subscribed calendars are presented as first-class items in the existing calendar sidebar — same
   colour, visibility, sharing, and CalDAV exposure as any other calendar.
4. CalDAV clients (Apple Calendar, Thunderbird, etc.) see subscribed calendars and their events,
   marked read-only.
5. Reuse the existing iCal pipeline where reuse is *safe*: `parseIcs()` (parsing, RRULE DoS guards,
   TZID normalisation, EXDATE synthesis), `computeEtag` (`apps/api/src/lib/calendar/mappers.ts`),
   the ctag/eventCtag/tombstone sync conventions, and the existing SSE event types. Do not
   introduce a parallel "imported event" *data model* — imported events are ordinary `events` rows.

## Non-goals

- **HTTP Basic / Digest credentials** for protected feeds. Public feeds and URL-token feeds (Google,
  iCloud, Outlook, Yahoo) cover the mainstream consumer providers; corporate / Nextcloud / Radicale
  feeds requiring Basic auth are deferred to a follow-up proposal.
- **Two-way CalDAV write-back**. Editing events from Eigen and pushing them to a remote Google /
  iCloud / Nextcloud account is a separate "Add CalDAV account" feature, materially different in
  scope (OAuth2 per provider, sync state machine, conflict resolution UI). See *§ Why subscriptions
  stay read-only* below.
- **OAuth2 flows** for Google / Microsoft. Same reason — that belongs to the CalDAV-account feature.
- **Subscription-level discovery** (CalDAV `PROPFIND` on a remote root to enumerate calendars). A
  subscription is a single feed URL.
- **Server-side background refresh for calendars nobody is reading.** Reminders are delivered
  client-side in Eigen (there is no server-side reminder job in `apps/api/src/lib/scheduler/jobs.ts`),
  so freshness only matters at read time — and every reader triggers a refresh (see § Refresh
  mechanism).

## Why now

Calendar already has a strong foundation: `parseIcs()` driven by `ical.js` handles VEVENT, VALARM
(→ `data.reminders`), RRULE (including the sub-daily / out-of-range DoS guards from
`recurrence-limits.ts`), attendees, organizer, EXDATE (synthesised as cancelled exception rows),
RECURRENCE-ID (→ `recurrenceDate`), TZID normalisation, SEQUENCE coercion, and METHOD. iMIP routes
inbound `text/calendar` attachments through this same parser. Recurrence expansion
(`recurrence.ts`) recently gained correct DST fall-back handling. The hard work — RFC 5545
compliance, recurrence, timezone-aware DTSTART — is done. Importing a feed is roughly *the same
parser, a different transport*.

The remaining gap is orchestration: fetch over HTTP, diff against existing rows, surface the
calendar in the sidebar — plus one new bulk write primitive, because the existing per-event
mutation methods have side effects (SSE, ctag bumps, invitation propagation) that must not run per
feed event.

## Architecture

A subscription is **a flavour of calendar, not a separate entity**. The `calendars` table
(`apps/api/src/lib/calendar/schema.ts`) gains one nullable JSON column:

```typescript
// CalendarSubscription in packages/lib/src/types/calendar.ts
subscription: {
    url: string;              // canonicalised https:// (webcal:// stripped)
    refreshIntervalMs: number; // default 3600_000 (1 hour); presets 15m / 1h / 1d
    lastFetchedAt: number;    // ms epoch, 0 if never
    lastSuccessAt: number;    // ms epoch of last 200/304
    lastError?: string;       // user-visible failure reason from last attempt
    etag?: string;            // HTTP ETag from last 200, sent as If-None-Match
    lastModified?: string;    // HTTP Last-Modified, sent as If-Modified-Since
} | null
```

`subscription === null` → owned calendar, current behaviour, fully writable. `subscription !== null`
→ subscribed calendar, read-only, events refreshed from `url`. The row *is* the calendar; the
subscription metadata is part of it. No `calendar_subscriptions` join table.

The same model covers file-import-into-new-calendar (the calendar is created with `subscription =
null` and seeded from the parsed file). File-import-into-existing-calendar is a bulk insert into an
existing owned calendar.

| Origin | `subscription` | Writable | Refresh |
|---|---|---|---|
| User-created (today) | `null` | yes | n/a |
| File import → new calendar | `null` | yes | n/a |
| File import → existing calendar | `null` | yes | n/a |
| URL subscription | `{ url, … }` | no | on access + manual |

### Migration

`CALENDAR_DB_CONFIG` (`apps/api/src/lib/calendar/db-config.ts`) is a versioned `DatabaseConfig`
currently at `currentVersion: 1`; `ManagedDatabase` runs pending migrations on open. Bump to
`currentVersion: 2` and add:

```typescript
{ version: 2, up: (db) => db.exec(`ALTER TABLE calendars ADD COLUMN subscription TEXT`) }
```

plus the matching Drizzle column in `schema.ts`
(`text('subscription', { mode: 'json' }).$type<CalendarSubscription | null>()`). Additive and
nullable — existing rows read back as `null` (owned). Frozen-format risk: **low**, no existing
column or value changes meaning.

## Refresh mechanism

Refresh is **on-access only**. Three triggers, all funnelling into one
`refreshDueSubscriptions()` method that selects calendars where
`subscription IS NOT NULL AND lastFetchedAt + refreshIntervalMs < now`:

1. **Web read.** In the `GET /calendar/:ownerId/event-range/:from/:to` handler
   (`apps/api/src/routes/calendar.ts`), after the events query returns, fire-and-forget
   `cal.refreshDueSubscriptions().catch(...)`. The current request returns potentially-stale data;
   when the refresh lands it broadcasts the existing `CALENDAR_EVENT_UPDATED` /`CALENDAR_UPDATED`
   SSE events, which the existing handler in `packages/lib/src/core/calendar/sse-handlers.ts`
   already routes to query invalidation — the UI updates within seconds.
2. **CalDAV read.** Same fire-and-forget hook where the CalDAV layer serves a calendar collection
   (calendar-collection PROPFIND / calendar-query & sync REPORT paths in
   `apps/api/src/lib/caldav/caldav-router.ts`). A Mac with Apple Calendar polling every 5–15
   minutes therefore keeps the feed fresh with no browser tab open — the poll itself opens the
   Home and triggers the refresh, and the *next* poll picks up the new ctag.
3. **Manual.** `POST /calendar/:ownerId/subscriptions/:calId/refresh` — the sidebar's
   "Refresh now", which ignores `refreshIntervalMs`.

**Deliberately rejected: timers.** The codebase *does* have scheduler infrastructure —
`scheduleInterval(name, ms, fn)` in `apps/api/src/lib/scheduler/scheduler.ts`, registered in
`jobs.ts` — but a server-wide sweep would have to enumerate and open every Home that might hold a
subscription (~30 fds per open Home, see `PROPOSAL_FD_BUDGET.md`) to refresh feeds nobody is
looking at. A per-Home `setInterval` has the same "refresh what nobody reads" property plus a
lifecycle entanglement with Home GC-close. Since nothing server-side consumes calendar data when no
client is reading (reminders are client-side), on-access covers every case that matters. If a
server-side reminder/digest feature lands later, revisit with a `scheduleInterval` job then.

A simple in-memory `Set<calendarId>` on the `Calendar` instance prevents concurrent refresh of the
same subscription when two triggers race. If the Home is closed mid-refresh the write throws and is
caught by the fire-and-forget `.catch`; the next read retries. No durable queue — feeds are
advisory, not transactional.

### `refreshSubscription(calendarId)` flow

Lives in a new `apps/api/src/lib/calendar/subscription.ts` (plain functions over the `Calendar`
instance, matching how `share-propagation.ts` / `invite-propagation.ts` sit beside `calendar.ts`).

1. Validate the URL against the fetch policy (§ SSRF). Build conditional headers from
   `subscription.etag` / `subscription.lastModified`.
2. `fetch(subscription.url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) })`,
   following at most 5 redirects by manual loop (each hop re-validated against the fetch policy).
   Cap the body at 20 MB (abort mid-stream past the cap).
3. **HTTP 304** — bump `lastFetchedAt` and `lastSuccessAt`, leave events untouched.
4. **HTTP 200** — run the body through `parseIcs()`, cap at 10 000 parsed events, then apply the
   snapshot (below) and update `subscription.etag` / `lastModified` / `lastFetchedAt` /
   `lastSuccessAt`, clear `lastError`.
5. **HTTP error / network failure / parse error** — store a terse reason in
   `subscription.lastError`, bump `lastFetchedAt` (so a broken feed isn't hammered on every read),
   leave events untouched, do not bump `lastSuccessAt`. Broadcast `CALENDAR_UPDATED` so the sidebar
   error dot appears.

### Applying a feed snapshot (the diff)

One new domain-level bulk primitive, `applyFeedSnapshot(calendarId, parsed: ParsedEvent[])`, runs
in a single transaction. **It must not loop the public `createEvent`/`updateEvent`/`deleteEvent`**,
for three verified reasons:

- `deleteEvent` fires `propagateCancellation` whenever the deleted event has `data.attendees` —
  *even with no `user` argument*. Feed events routinely carry `ATTENDEE` lines, so a naive
  reuse would send cancellation traffic (relay messages / iMIP mails) to strangers on every feed
  removal.
- `createEvent`/`updateEvent`/`deleteEvent` each bump the ctag and broadcast SSE (plus
  `notifySharedCalendarUsers`) per call — a 5 000-event feed would emit 5 000 broadcasts.
- `createEvent` would need a bypass around the new read-only guard.

The primitive instead reuses the *conventions*: `computeEtag` for the per-event etag, one
`ctag` increment for the whole batch with the new value stamped into `eventCtag` on every
inserted/updated row (so `getChangedEventsSince` sees them), and an `event_tombstones` row per
deletion with `deletedAtCtag` set to the same new ctag (so CalDAV sync-token clients see removals —
mirror what `deleteEvent` writes).

Diff identity is **`(uid, recurrenceDate ?? null)`** — *not* `uid` alone. A recurring feed event is
several `ParsedEvent`s sharing one UID: the master (`recurrenceDate: null`) plus one row per
RECURRENCE-ID exception and per EXDATE-synthesised cancellation. Keying by bare UID would collapse
them. Per key:

- **In remote, not local** → insert. Masters first; then exception rows (non-null
  `recurrenceDate`) get `parentEventId` pointing at the just-inserted/existing master with the same
  UID, and the master's `uid` (the same convention `Calendar.createEvent` uses for exceptions:
  shared UID, `uri` of `${uid}-exc-${recurrenceDate}.ics`). An exception with no master in the feed
  is skipped.
- **In both** → compare `computeEtag` of the incoming mapped fields against the stored `etag`;
  if unchanged, skip (no write, no `eventCtag` stamp). If changed, update every field *except*
  `data.color` and `data.reminders`, which keep their stored values (local overrides; feed VALARMs
  only seed `data.reminders` on first insert). SEQUENCE is stored but not used for conflict logic —
  a feed is a full snapshot, so snapshot-wins is correct; SEQUENCE ordering matters only for
  incremental iMIP messaging (`receiveInvitationUpdate`), which this path never touches.
- **In local, not remote** → delete the row + write the tombstone. Deleting a master cascades its
  exceptions (`events.parentEventId` FK is `ON DELETE CASCADE`).
- Events with `STATUS:CANCELLED` in the feed are stored as-is (`parseIcs` maps status); cancelled
  exception rows already suppress their occurrence in `getEventsInRange`. Upstream deletions
  normally just vanish from the feed and hit the delete branch.

After the transaction: one `CALENDAR_EVENT_UPDATED` + one `CALENDAR_UPDATED` broadcast via
`buildCalendarEvent` (`sse-events.ts`), plus one `notifySharedCalendarUsers` call if the calendar
has shares. **No new SSE event type** — the existing coarse `{ type, ownerId }` calendar events and
their handlers already invalidate the right queries (`subscription.lastError` / `lastFetchedAt`
ride on the calendars query).

### Webcal scheme

`webcal://` is a UI-only marker scheme; convert to `https://` (or `http://` only if the user
explicitly typed it) before storing and fetching.

## SSRF policy for the feed fetch (the roadmap's open decision — decided)

Context: Eigen's primary deployment shape is single-org self-hosted, where private-network fetches
are often *legitimate* (an intranet Radicale/Baïkal feed, a holiday feed on the LAN). Precedent: a
previous blanket SSRF guard broke MinIO-on-LAN for self-hosters and had to be reverted. A blanket
block is wrong here; a silent allow is also wrong. The decision:

- **Always enforced, no toggle**: scheme must be `http:` or `https:` after webcal
  canonicalisation; URL userinfo (`user:pass@host`) is stripped/rejected (Basic auth is a
  non-goal); the link-local range `169.254.0.0/16` and its IPv6 equivalent are always blocked
  (cloud metadata endpoints — never a calendar feed); redirects are re-validated per hop; the
  fetch sends no cookies or Eigen credentials.
- **Server setting** `calendar.allowPrivateFeedUrls` (via the runtime-adjustable
  `server-settings.ts` pattern), **default `true`**. When `false`, resolve the hostname before
  fetching and reject loopback, RFC 1918, CGNAT, and IPv6 unique-local/loopback targets — checked
  again on every redirect hop.
- **Documented residual risk** with the default: an authenticated org user can probe
  LAN/localhost ports via the shape of `subscription.lastError` (connection refused vs parse
  error). Accepted for self-hosted single-org deployments (users are the org's own members);
  multi-tenant / hosted deployments (eigen.is) should set `allowPrivateFeedUrls = false` at
  deploy time. DNS-rebinding between check and fetch is a known residual when the toggle is off;
  accepted (the fetch carries no credentials and the response is only ever parsed as iCalendar).

There is no reusable SSRF guard elsewhere in the codebase to import (the PDF-export SSRF handling
in `lib/export/` is weasyprint-specific), so this small policy lives in
`calendar/subscription.ts` next to its only caller.

## File import

Reuse `parseIcs()`. The `POST /calendar/:ownerId/imports` route:

1. Accepts a multipart upload with the `.ics` file plus fields specifying the target: either
   `{ mode: 'new', name?: string, color?: string }` or `{ mode: 'existing', calendarId: string }`.
2. Parses, then either creates a new owned calendar (default name from `X-WR-CALNAME` or the
   filename minus extension; default colour from `X-APPLE-CALENDAR-COLOR` if present) or resolves
   the existing calendar — rejecting subscribed targets via the read-only guard.
3. Bulk-inserts through the same snapshot primitive's insert path (single transaction, one ctag
   bump, one SSE broadcast), with two import-specific rules: `data.organizer` is **stripped**
   (otherwise `updateEvent`'s linked-event guard would treat the imported copy as an attendee's
   linked event and lock its fields to reminders/colour), and no invitation propagation runs
   (attendee lists are kept as display data only).
4. Returns the calendar plus inserted-event count.

Once imported, events are normal owned events — no `subscription`, fully editable, identical to
hand-created ones.

## Frontend UX

The "+" button in `apps/calendar/src/components/calendar-sidebar.tsx` becomes a small dropdown:

- **New calendar** (existing flow)
- **Subscribe to URL…** (new dialog)
- **Import from file…** (new dialog)

### Subscribe dialog

- URL input with a basic shape check (scheme + host), not full RFC validation.
- **Preview** button → `POST /calendar/:ownerId/subscriptions/preview` with `{ url }` → server
  fetches once (same fetch policy) and returns `{ name, eventCount, dateRange, suggestedColor }`
  from `X-WR-CALNAME` / `X-APPLE-CALENDAR-COLOR` / the parsed events.
- Editable name (defaults from preview), colour swatch picker, refresh interval radio (15 min /
  1 hour / 1 day).
- Submit → `POST /calendar/:ownerId/subscriptions` creates the calendar row with `subscription`
  populated, runs the initial sync inline, returns the calendar. The sidebar updates via the
  existing `CALENDAR_CREATED` invalidation.

### Import dialog

- Drag-drop or file picker for `.ics`.
- Target: radio group "Create new calendar" / "Add to existing calendar [picker]".
- Server-side parse for preview after file selection: event count, date range, name hint.
- Submit → `POST /calendar/:ownerId/imports` (multipart).

Both dialogs follow the shared Dialog components used by
`apps/calendar/src/components/calendar-config-dialog.tsx`.

### Sidebar treatment of subscribed calendars

A small `Globe` icon (lucide-react) renders next to the calendar name. Context menu adds:

- **Refresh now** → `POST /calendar/:ownerId/subscriptions/:calId/refresh`.
- **Edit subscription** → the Subscribe dialog pre-filled (URL and interval editable, preview
  re-runs).
- **Unsubscribe** → standard delete via `DeleteDialog` from
  `packages/ui/src/components/delete/`. No special unsubscribe path — `deleteCalendar(id)`
  cascades events as today (its share-revocation propagation included).

Error state from `subscription.lastError` shows as a small red dot next to the Globe icon, with
the message in a tooltip.

### Event detail for subscribed events

When an event in a subscribed calendar is opened
(`apps/calendar/src/components/event-detail-dialog.tsx` / `edit-event-dialog.tsx`), render title,
time, location, attendees, recurrence as read-only text. Colour and reminder fields stay editable —
the local overrides that survive refresh.

## Read-only enforcement

A single guard on the domain class:

```typescript
// apps/api/src/lib/calendar/calendar.ts
private assertWritableCalendar(calendarId: string) {
    const cal = this.getCalendarById(calendarId);
    if (cal?.subscription) throw new ApiError(403, 'Cannot modify a subscribed calendar');
}
```

Called at the top of `createEvent`, `updateEvent`, and `deleteEvent`. Because web routes reach
these through the home-relay (`createEventAt`/`updateEventAt`/`deleteEventAt`) and CalDAV writes
reach the same domain methods, one guard covers every write surface. `updateCalendar` is **not**
guarded — `name`, `color`, `visible`, and `shares` are local metadata and stay editable on a
subscribed calendar.

The local-override exception: `updateEvent` already contains exactly this pattern for linked
invitation events — when `existing.data?.organizer` is set, the input is rewritten to only carry
`data.reminders`/`data.color`. The subscribed-calendar case reuses that shape: if the calendar is
subscribed and the input touches only `data.color`/`data.reminders`, rewrite-and-allow instead of
throwing.

Internal writers bypass the guard by construction: `applyFeedSnapshot` and the import bulk insert
write through their own transaction, not through `createEvent`.

A `SharedDrive`-style wrapper class would be over-engineering: the gradient is binary
(writable / not), there is no permission tier per method, and no method needs different behaviour
beyond raising `ApiError`. The Drive system uses the wrapper because permissions are graded; this
isn't.

## Sharing semantics

Subscribed calendars **can be shared** with other users / teams using the existing share
mechanism. One clamp in `Calendar.checkPermission`: return at most `'read'` when
`subscription !== null` (a nominal `write` share resolves to `read`). This single clamp propagates
everywhere by construction, verified against current code:

- `checkCalendarAccess` (`get-calendar.ts`) resolves cross-user and team permissions through
  `pullCalendarPermission` → `checkPermission`, so route-level write checks
  (`permission !== 'write'` → 403) reject before the relay is even called.
- `propagateCalendarShare` (`share-propagation.ts`) resolves each recipient's permission through
  `checkPermission` before `sendToHome`, so recipients' `shared_calendars` rows store `read` and
  their UI shows no write affordances.
- `syncTeamCalendars`'s repair loop re-resolves through the same function.

The `ownerId === user.id` fast path in `checkCalendarAccess` returns `'write'` without consulting
`checkPermission` — that's the owner's own subscribed calendar, caught by
`assertWritableCalendar` at the domain layer.

## CalDAV server changes

Two pieces:

1. **Enforcement** is already covered: CalDAV PUT/DELETE on a subscribed calendar reaches the
   guarded domain methods and gets `403 Forbidden` regardless of what the client believes.
2. **Advertisement**: emit `DAV:current-user-privilege-set` with `<read/>` only (no
   `<write/>`/`<write-content/>`) in calendar-collection PROPFIND responses for subscribed
   calendars, so Apple Calendar / Thunderbird grey out editing. Note this property is **not
   emitted at all today** — this is a new property in the PROPFIND generation for calendar
   collections (`apps/api/src/lib/caldav/caldav-router.ts` + the props builders it uses), added
   only for subscribed collections (owned collections keep today's behaviour; clients assume
   writable in the property's absence).

## Edge cases

- **`webcal://`** → canonicalise to `https://` before storing and fetching.
- **HTTP redirects** → manual loop, max 5 hops, each hop re-validated against the fetch policy
  (`redirect: 'manual'`; Bun's fetch doesn't expose a hop limit directly).
- **Malformed iCal** → `parseIcs` throws; caught in `refreshSubscription`, stored as
  `subscription.lastError`. Events untouched.
- **Massive feeds** → 20 MB body cap, 10 000-event cap. Defensive ceilings, not real limits.
- **Network timeout** → `AbortSignal.timeout(30_000)`.
- **Concurrent refresh races** → in-memory `Set<calendarId>` per `Calendar` instance.
- **Recurrence + timezones** → handled by `parseIcs` + `recurrence.ts` (including the RRULE DoS
  guards from `recurrence-limits.ts`, which `parseIcs` applies by degrading hostile RRULEs to
  single events, and the DST fall-back fixes). No new code path.
- **Feed events carrying `ATTENDEE`/`ORGANIZER`** → stored as display data only; no invitation,
  RSVP, or cancellation propagation may ever run from the subscription/import paths (see the
  `deleteEvent`-reuse hazard in § Applying a feed snapshot).
- **Sharing a subscribed calendar** → allowed; `checkPermission` clamps to `read`.
- **Deleting a subscribed calendar** → standard `deleteCalendar(id)`; cascades events, propagates
  share revocation. No special unsubscribe code.
- **Server restart / Home close mid-fetch** → no durable state; the next read triggers the next
  refresh. Feeds are advisory, not transactional.
- **Duplicate UIDs across *different* subscriptions** → fine; all event queries and the
  `idx_events_uri_calendar` uniqueness are calendar-scoped.

## Why subscriptions stay read-only

There are three reasonable points on the edit-subscribed-calendar spectrum, and the case for "ship
read-only" is strong.

| Tier | Behaviour | Effort | Verdict |
|---|---|---|---|
| **A** | Strict read-only. `color` / `reminders` are local overrides. | (this proposal) | Ship. |
| **B** | Local-override editing extended to `title` / `notes` / `location`. New events allowed locally alongside imported ones. Deletes hide locally. | 2–3 days | **Reject.** Creates lies in the data — an overridden title silently diverges from an upstream rename. UX confusion outweighs usefulness. |
| **C** | Full two-way CalDAV sync — write events back to the remote. | weeks, ongoing | Belongs to a separate "Add CalDAV account" feature. URL-token feeds (Google public, holiday feeds) **cannot** support write-back at the protocol level. Two-way sync only makes sense over CalDAV/EWS/Graph with full auth — a different product surface from "subscribe to a feed". |

Tier A matches the universal convention across Apple Calendar, Google Calendar, Outlook, and
Thunderbird. Users coming from any of those products will have correct expectations.

## Backend pieces

| Layer | File | Change |
|---|---|---|
| Schema | `apps/api/src/lib/calendar/schema.ts` | Nullable `subscription` JSON column on `calendars`. |
| Migration | `apps/api/src/lib/calendar/db-config.ts` | `currentVersion` 1 → 2; `ALTER TABLE calendars ADD COLUMN subscription TEXT`. |
| Domain | `apps/api/src/lib/calendar/calendar.ts` | `assertWritableCalendar` + calls in `createEvent`/`updateEvent`/`deleteEvent` (with the local-override carve-out in `updateEvent`); `checkPermission` clamp; `refreshDueSubscriptions` entry point + in-flight `Set`. |
| Subscription core | `apps/api/src/lib/calendar/subscription.ts` *(new)* | Fetch policy (SSRF §), conditional-header fetch, redirect loop, `applyFeedSnapshot` diff (single transaction, one ctag bump, tombstones), preview, import bulk insert. Plain functions over `Calendar`, like `share-propagation.ts`. |
| Routes | `apps/api/src/routes/calendar.ts` | `POST /calendar/:ownerId/subscriptions`, `…/subscriptions/preview`, `…/subscriptions/:calId/refresh`, `POST /calendar/:ownerId/imports`; fire-and-forget refresh hook in the event-range GET. |
| CalDAV | `apps/api/src/lib/caldav/caldav-router.ts` | `current-user-privilege-set` on subscribed collections; fire-and-forget refresh hook on calendar-collection reads. |
| Server settings | `apps/api/src/lib/config/server-settings.ts` | `calendar.allowPrivateFeedUrls` (default `true`). |
| Types | `packages/lib/src/types/calendar.ts` | `CalendarSubscription`; `subscription?` on `CalendarItem`. |
| Hooks | `packages/lib/src/core/calendar/hooks/use-calendar.ts` | `useCreateSubscription`, `usePreviewSubscription`, `useRefreshSubscription`, `useImportIcs`; errors via `onMutationError`. |
| SSE | — | **No new event type**; existing `CALENDAR_*` events + handlers suffice. |
| Sidebar UI | `apps/calendar/src/components/calendar-sidebar.tsx` | "+" dropdown; Globe icon + error dot; context-menu items. |
| Dialogs | `apps/calendar/src/components/subscribe-dialog.tsx`, `import-dialog.tsx` *(new)* | Shared Dialog system, modelled on `calendar-config-dialog.tsx`. |
| Event detail | `apps/calendar/src/components/event-detail-dialog.tsx`, `edit-event-dialog.tsx` | Read-only rendering for subscribed events; colour/reminders stay editable. |

## What's deferred

- **HTTP Basic auth** for protected feeds (Nextcloud, Radicale). Small addition later: optional
  `auth` in the `subscription` JSON, password never echoed through the API, one header in the
  fetch helper.
- **Two-way CalDAV sync / OAuth2** — a future *Add CalDAV Account* proposal; different mental
  model ("connected account", not "subscribed feed").
- **Per-calendar custom refresh interval** beyond the three presets.
- **Server-side background refresh** — revisit only if a server-side consumer of calendar data
  appears (reminder emails, digests); the `scheduleInterval` seam is where it would go.

## Testing

Extend `apps/api/src/test/calendar.test.ts` using `getTestContext()` / `authedRequest()` from
`setup.ts`, serving fixture feeds from an in-process `Bun.serve`:

- Subscribe → events appear; feed change + refresh → adds/updates/deletes apply; tombstones exist
  (`getDeletedEventsSince` shows removals) and the calendar ctag advanced exactly once per refresh.
- Recurring feed with RECURRENCE-ID exception + EXDATE → master + exception rows linked via
  `parentEventId`, occurrence suppressed; keyed diff doesn't collapse same-UID rows.
- 304 path bumps timestamps without re-diffing; malformed iCal stores `lastError`, events intact.
- Feed events with `ATTENDEE` lines: refresh insert + refresh delete fire **no** invitation or
  cancellation propagation (no relay sends, no mails).
- Mutations on a subscribed calendar → 403; `data.color`/`data.reminders`-only update succeeds and
  survives the next refresh.
- File import into a new calendar → writable events, `data.organizer` stripped; import into a
  subscribed calendar → 403.
- Share a subscribed calendar with `write` → recipient's resolved permission is `read`; recipient
  event mutation → 403.
- Fetch policy: `webcal://` canonicalised; userinfo URL rejected; with `allowPrivateFeedUrls =
  false`, loopback/RFC 1918 feed URL rejected (and on a redirect hop); link-local always rejected.
