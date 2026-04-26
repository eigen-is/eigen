# Proposal: Importing External Calendars

> **TLDR**: Let users add external calendars in two flavours — a one-time `.ics` file import and a
> live URL subscription (Google public calendars, holiday feeds, conference schedules, sports
> calendars, etc.). Treat a subscription as a flavour of `Calendar`, not a separate entity: a row in
> the `calendars` table is either *owned* (writable, current behaviour) or *subscribed* (read-only,
> refreshed from a URL) based on a nullable `subscription` JSON column. Reuse the existing
> `parseIcs()` (already running for iMIP) and the existing event creation pipeline. Refresh combines
> a lazy on-access trigger with a 15-minute Home-tied interval — no new scheduler infrastructure.
> Subscribed calendars are strict read-only with `color`/`reminders` preserved as local overrides
> across refresh, matching Apple Calendar / Google Calendar / Outlook conventions. HTTP Basic auth
> and two-way CalDAV write-back are explicit non-goals deferred to later proposals.

## Goals

1. Users can paste a `webcal://` or `https://…/feed.ics` URL and have the events appear in their
   calendar app, kept in sync automatically.
2. Users can upload an `.ics` file as a one-time import, either into an existing calendar or into a
   new one seeded from the file.
3. Subscribed calendars are presented as first-class items in the existing calendar sidebar — same
   colour, visibility, sharing, and CalDAV exposure as any other calendar.
4. CalDAV clients (Apple Calendar, Thunderbird, etc.) see subscribed calendars and their events,
   marked read-only.
5. Reuse every part of the existing iCal pipeline (`parseIcs`, RRULE expansion, `Calendar.createEvent`,
   SSE emission). Do not introduce a parallel "imported event" code path.

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
- **Offline editing** of imported events. Imports go through the API like any other write.

## Why now

Calendar already has a strong foundation: `parseIcs()` driven by `ical.js` v2.2.1 handles VEVENT,
VALARM, RRULE, attendees, EXDATE, timezones, and METHOD. iMIP routes inbound `text/calendar`
attachments through this same parser into `Calendar.receiveInvitation()`. The hard work — RFC 5545
compliance, recurrence expansion, timezone-aware DTSTART handling, the `external_{email}` organizer
convention — is done. Importing a feed is roughly *the same parser, a different transport*.

The remaining gap is purely orchestration: fetch over HTTP on a schedule, diff by `uid`, surface the
calendar in the sidebar. Nothing about the data model needs to change.

## Architecture

A subscription is **a flavour of calendar, not a separate entity**. The `calendars` table gains one
nullable JSON column:

```typescript
// apps/api/src/lib/calendar/schema.ts
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
null` and seeded from the parsed file). File-import-into-existing-calendar is just bulk
`createEvent` calls.

| Origin | `subscription` | Writable | Refresh |
|---|---|---|---|
| User-created (today) | `null` | yes | n/a |
| File import → new calendar | `null` | yes | n/a |
| File import → existing calendar | `null` | yes | n/a |
| URL subscription | `{ url, … }` | no | lazy + interval |

## Refresh mechanism

Subscriptions need to be re-fetched periodically. There is no scheduler infrastructure in the
codebase today, and adding a generic one for one feature would be over-engineering. Instead, two
cheap triggers cover the cases that matter:

**Lazy on access.** In the `GET /calendar/:ownerId/event-range/:from/:to` route, after the events
query returns, fire-and-forget `home.calendar.refreshDueSubscriptions().catch(...)`. The current
request returns potentially-stale data; the *next* request after refresh completes returns fresh.
The `calendar:subscription-refreshed` SSE event fires when each subscription updates, which the
frontend SSE handler routes to `queryClient.invalidateQueries(calendarKeys.events(ownerId))` — so
the UI updates within seconds even though the originating request was stale.

**Home-tied interval.** In `UserHome.init()`:

```typescript
this.subscriptionTimer = setInterval(
    () => this.calendar.refreshDueSubscriptions().catch(err => log.error(err)),
    15 * 60_000,
);
```

Cleared on `Home.close()`. This keeps subscriptions fresh for users with active CalDAV clients but
no open browser tab. Both triggers call the same `refreshDueSubscriptions()` method, which selects
calendars where `subscription IS NOT NULL AND lastFetchedAt + refreshIntervalMs < now`.

A simple in-memory `Set<calendarId>` lock per Home prevents concurrent refresh of the same
subscription if a lazy and an interval-driven refresh race.

### `refreshSubscription(calendarId)` flow

1. Build conditional headers from `subscription.etag` / `subscription.lastModified`.
2. `fetch(subscription.url, { headers, signal: AbortSignal.timeout(30_000) })`.
3. **HTTP 304** — bump `lastFetchedAt` and `lastSuccessAt`, leave events untouched.
4. **HTTP 200** — read body, run through `parseIcs()`, then in a single transaction:
   - Build `Map<uid, ParsedEvent>` from remote.
   - For every existing event in this calendar:
     - In remote map → update fields, **preserve `data.color` and `data.reminders`** if present.
     - Not in remote map → delete (and write tombstone for CalDAV sync).
   - For every remote event not in existing → insert.
   - Bump `ctag` once at the end.
   - Update `subscription.etag`, `subscription.lastModified`, `lastFetchedAt`, `lastSuccessAt`.
5. **HTTP error / network failure / parse error** — store `subscription.lastError`, leave events
   untouched, do not bump `lastSuccessAt`.

### Webcal scheme

`webcal://` is a UI-only marker scheme; convert to `https://` (or `http://` only if the user
explicitly typed it) before storing and fetching.

## File import

Reuse `parseIcs()`. The `POST /calendar/:ownerId/imports` route:

1. Accepts a multipart upload with the `.ics` file plus a JSON body specifying target: either
   `{ mode: 'new', name?: string, color?: string }` or `{ mode: 'existing', calendarId: string }`.
2. Parses, then either creates a new owned calendar (default name from `X-WR-CALNAME` or the
   filename minus extension; default colour from `X-APPLE-CALENDAR-COLOR` if present) or resolves
   the existing calendar with a write check.
3. Bulk `createEvent` calls inside a single transaction. Bump `ctag` once.
4. Returns the calendar plus event count.

Once imported, events are normal owned events. No `subscription` field. Fully editable. Identical
in every respect to events the user creates by hand.

## Frontend UX

The "+" button in `apps/calendar/src/components/calendar-sidebar.tsx` becomes a small dropdown:

- **New calendar** (existing flow)
- **Subscribe to URL…** (new dialog)
- **Import from file…** (new dialog)

### Subscribe dialog

- URL input with format validation (basic shape check, not a full RFC validation).
- **Preview** button → calls `POST /calendar/:ownerId/subscriptions/preview` with `{ url }` →
  server fetches once and returns `{ name, eventCount, dateRange, suggestedColor }` parsed from
  `X-WR-CALNAME` / `X-APPLE-CALENDAR-COLOR` / event count.
- Editable name (defaults from preview), colour swatch picker, refresh interval radio (15 min /
  1 hour / 1 day).
- Submit → `POST /calendar/:ownerId/subscriptions` creates the calendar row with `subscription`
  populated, runs the initial sync inline, returns the calendar. The new entry shows up in the
  sidebar via SSE invalidation.

### Import dialog

- Drag-drop or file picker for `.ics`.
- Target: radio group "Create new calendar" / "Add to existing calendar [picker]".
- After file is selected, server-side parse for preview: event count, date range, calendar name
  hint.
- Submit → `POST /calendar/:ownerId/imports` (multipart).

### Sidebar treatment of subscribed calendars

A small `Globe` icon (lucide-react) renders next to the calendar name. Context menu adds:

- **Refresh now** → `POST /calendar/:ownerId/subscriptions/:id/refresh` — manual refresh.
- **Edit subscription** → opens the Subscribe dialog pre-filled (URL editable, refresh interval
  editable, preview re-runs).
- **Unsubscribe** → standard delete via `DeleteDialog` from `packages/ui/src/components/layout/delete/`.
  No special unsubscribe code path — `deleteCalendar(id)` cascades to events as today.

Error state from `subscription.lastError` shows as a small red dot next to the Globe icon, with the
last-error message in a tooltip.

### Event detail for imported events

When an event in a subscribed calendar is opened, the detail view renders title, time, location,
attendees, recurrence as plain read-only text (not inputs). Colour and reminder fields stay
editable — these are the local overrides that survive refresh.

## Read-only enforcement

A single guard on the domain class:

```typescript
// apps/api/src/lib/calendar/calendar.ts
private async assertWritableCalendar(calendarId: string) {
    const cal = await this.getCalendar(calendarId);
    if (cal.subscription) {
        throw new ApiError(403, 'Cannot modify a subscribed calendar');
    }
}
```

Called from `createEvent`, `updateEvent`, `deleteEvent`, and any share mutation that targets the
calendar itself. The exception is the per-event `updateEvent(eventId, { color?, reminders? })`
shape used for local overrides — that path skips the guard but explicitly only writes those two
fields.

A `SharedDrive`-style wrapper class would be over-engineering: the gradient is binary
(writable / not writable), there is no permission tier, and no method needs different behaviour
beyond raising `ApiError`. The Drive system uses the wrapper because permissions are graded; this
isn't.

### Local override preservation

On every refresh, when an event still exists in the remote feed, every field updates *except*
`data.color` and `data.reminders`. So the user can re-colour an imported event or set a personal
reminder and it survives the next sync. This is the iCal-standard local-customisation pattern —
matches what Apple Calendar and Google Calendar do for subscribed feeds.

## Why subscriptions stay read-only

There are three reasonable points on the edit-subscribed-calendar spectrum, and the case for "ship
read-only" is strong.

| Tier | Behaviour | Effort | Verdict |
|---|---|---|---|
| **A** | Strict read-only. `color` / `reminders` are local overrides. | (this proposal) | Ship. |
| **B** | Local-override editing extended to `title` / `notes` / `location`. New events allowed locally and live alongside imported ones. Deletes hide locally. | 2–3 days | **Reject.** Creates lies in the data — overridden title silently diverges from the upstream rename, "Team Standup" stays "Team Standup" while the source becomes "Daily Sync". UX confusion outweighs usefulness. |
| **C** | Full two-way CalDAV sync — write events back to the remote. | 3–4 weeks for the basics, longer for production multi-provider | Belongs to a separate "Add CalDAV account" feature. URL-token feeds (Google public, holiday feeds) **cannot** support write-back at the protocol level — they're read-only by design. Two-way sync only makes sense over CalDAV/EWS/Graph with full auth, which is materially different from "subscribe to a feed URL". |

Tier A matches the universal convention across Apple Calendar, Google Calendar, Outlook, and
Thunderbird. Users coming from any of those products will have correct expectations.

If the demand for "edit my Google Calendar from Eigen" is real, the right answer is a follow-up
proposal — *Add CalDAV Account* — that pursues OAuth2 + CalDAV-client functionality. That's a
different product surface from "subscribe to a feed", even if the visual presentation in the
sidebar overlaps.

## Sharing semantics

Subscribed calendars **can be shared** with other users / teams using the existing share mechanism.
Read-only propagates naturally: recipients see read-only events because the upstream calendar is
read-only. The existing `checkPermission()` returns at most `read` for events whose calendar has
`subscription !== null`, regardless of the share's nominal permission level (a `write` share on a
read-only calendar still resolves to `read`). One-line clamp in `checkPermission()`.

## CalDAV server changes

In `apps/api/src/lib/caldav/caldav-router.ts`, when generating PROPFIND responses for a calendar
collection where `subscription !== null`, set `current-user-privilege-set` to `<read/>` only (omit
`<write/>`). This causes Apple Calendar, Thunderbird, etc. to render the calendar as read-only and
suppress write affordances. The actual server-side enforcement is already done by
`assertWritableCalendar` on the domain layer, so a CalDAV PUT against a subscribed calendar
returns `403 Forbidden` regardless of what the client thinks its privileges are.

## SSE events

One new event type added to `packages/lib/src/types/sse.ts`:

```typescript
| { type: 'calendar:subscription-refreshed'; ownerId: string; calendarId: string; ok: boolean }
```

Frontend handler invalidates `calendarKeys.events(ownerId)` (because event content may have
changed) and `calendarKeys.calendars(ownerId)` (because `subscription.lastFetchedAt` /
`subscription.lastError` will have updated). Existing `calendar:event-created/updated/deleted`
events also fire as part of the refresh diff for fine-grained invalidation downstream.

## Edge cases

- **`webcal://`** → strip to `https://` before fetching.
- **HTTP redirects** → Bun's `fetch` follows by default. Cap at 5 redirects via manual loop if
  needed (Bun doesn't expose a count limit directly).
- **Malformed iCal** → `parseIcs` throws, caught at the top of `refreshSubscription`, stored as
  `subscription.lastError`. Events untouched.
- **Massive feeds** → cap at 10 000 events per feed. Defensive ceiling, not a real limit; feeds
  beyond this are misconfigured.
- **Network timeout** → 30s `AbortSignal.timeout(30_000)`.
- **Concurrent refresh races** → in-memory `Set<calendarId>` lock per Home.
- **Recurrence + timezones** → already handled by the existing `parseIcs` + RRULE expansion. No
  new code path.
- **Sharing a subscribed calendar** → allowed; `checkPermission()` clamps to `read`.
- **Deleting a subscribed calendar** → standard `deleteCalendar(id)`. Cascades events as today. No
  special unsubscribe code.
- **Server restart mid-fetch** → no durable queue; the next interval tick or lazy access triggers
  the next refresh. Acceptable: feeds are advisory, not transactional.
- **iCalendar `METHOD:CANCEL` in a feed** → treat as event cancellation in the diff (delete from
  local). Distinct from iMIP cancellation, which goes through `Calendar.removeInvitation()`.

## Backend pieces

| Layer | File | Change |
|---|---|---|
| Schema | `apps/api/src/lib/calendar/schema.ts` | Add nullable `subscription` JSON column on `calendars`. |
| Migration | `apps/api/src/lib/calendar/db-config.ts` | Bump version, add column. |
| Domain — calendars | `apps/api/src/lib/calendar/calendar.ts` | `subscribeToUrl`, `previewSubscription`, `refreshSubscription`, `refreshDueSubscriptions`, `assertWritableCalendar`, `importIcs`. Update `createEvent`/`updateEvent`/`deleteEvent` to call the guard. Update `checkPermission` to clamp to `read` for subscribed calendars. |
| Subscription core | `apps/api/src/lib/calendar/subscription.ts` *(new)* | HTTP fetch with conditional headers, ETag/Last-Modified handling, UID-based diff against existing events. |
| Home init | `apps/api/src/lib/home/user-home.ts` | Register interval timer in `init()`, clear in `close()`. |
| Routes | `apps/api/src/routes/calendar.ts` | `POST /subscriptions`, `POST /subscriptions/preview`, `POST /subscriptions/:id/refresh`, `POST /imports`. |
| Types | `packages/lib/src/types/calendar.ts` | `CalendarSubscription` type; optional `subscription?` on `CalendarItem`. |
| Hooks | `packages/lib/src/core/calendar/hooks/use-calendar.ts` | `useCreateSubscription`, `usePreviewSubscription`, `useRefreshSubscription`, `useImportIcs`. Wire `onMutationError`. |
| SSE types | `packages/lib/src/types/sse.ts` | `calendar:subscription-refreshed` event. |
| SSE handler | `packages/lib/src/core/calendar/sse-handlers.ts` | Route the new event to query invalidation. |
| Sidebar UI | `apps/calendar/src/components/calendar-sidebar.tsx` | Replace "+" button with dropdown; render Globe icon and error indicator on subscribed calendars; context menu items. |
| Dialogs | `apps/calendar/src/components/subscribe-dialog.tsx` *(new)* | Subscribe-to-URL dialog. |
| | `apps/calendar/src/components/import-dialog.tsx` *(new)* | File import dialog. |
| Event detail | `apps/calendar/src/components/event-detail.tsx` *(or wherever)* | Render write fields read-only when calendar is subscribed; keep colour/reminders editable. |
| CalDAV | `apps/api/src/lib/caldav/caldav-router.ts` | Mark subscribed calendars read-only via `current-user-privilege-set` in PROPFIND. |

## What's deferred

- **HTTP Basic auth** for protected feeds (Nextcloud, Radicale, Exchange-published-with-auth). Add
  in v1.5 if real demand surfaces. Implementation sketch is small: extend the `subscription` JSON
  with optional `auth: { type: 'basic'; username: string; password: string }`, strip
  `auth.password` from API responses (replace with placeholder), one extra header in the fetch
  helper, two more form fields in the subscribe dialog. ~50 lines.
- **Two-way CalDAV sync.** Belongs to *PROPOSAL_CALDAV_ACCOUNT* (not yet written). Different
  feature, different mental model: "connected account" rather than "subscribed feed". OAuth2 for
  Google, app-specific passwords for iCloud, sync state machine, conflict resolution UI.
- **OAuth2 for token-refreshing providers.** Same — belongs to the CalDAV-account feature.
- **Per-calendar custom refresh interval.** Three presets cover the 99% case.
- **Backfill / pruning of past events** beyond what the feed contains. The feed defines the truth.

## Testing

- `apps/api/src/test/calendar.test.ts` — extend with cases for:
  - Subscribe to a URL served by the test harness (bun's `Bun.serve` in-process), verify events
    appear and update on refresh.
  - 304 path bumps timestamps but doesn't re-diff.
  - Malformed iCal stores `lastError` without modifying events.
  - `assertWritableCalendar` rejects mutations on subscribed calendars.
  - Local override on `color` / `reminders` survives a refresh.
  - File import into a new calendar yields fully writable events.
  - File import into an existing calendar is rejected if the calendar is subscribed.
  - Sharing a subscribed calendar resolves recipient permission to `read` even if share is `write`.

Use the `getTestContext()` / `authedRequest()` helpers from `apps/api/src/test/setup.ts`.
