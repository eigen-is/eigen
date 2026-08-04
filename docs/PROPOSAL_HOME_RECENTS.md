# Proposal: Per-Home Recents

> **TLDR**: A per-user `home.recents` module records "implicit usage" — recently used
> email addresses and recently opened files — so the data feeds autosuggest and the
> command palette the next time the user reaches for them. **One typed Drizzle table
> per kind** in a new `eigen.recents/recents.db` on `UserHome`. All writes are
> **server-side** on canonical commit paths (mail send, ACL grant, chat mention,
> collab-doc open), cross-home via `home-relay` — the FE only reads. No SSE, no
> settings toggles in v1 (per-kind *Clear* instead). Auto-pruned from the per-Home
> lifecycle. Viewer-side sibling of the owner-side activity timeline in
> [FILE-HISTORY.md](FILE-HISTORY.md).
>
> *Revised 2026-06-12 after code verification + adversarial review: corrected the
> derive-vs-store argument (`emails.recipientsAll` exists) and the method names
> (`Mail.messageSend`, `Drive.updateACL`), fixed the ACL/team relay wiring, moved
> the file-open write server-side, dropped the SSE event, the settings toggles, the
> `context`/`firstUsedAt` columns, useCount on files, and the v1 Drive Recent view.*

## Goals

1. An email address used in mail compose / ACL share / chat mention reappears in
   autosuggest next time, ranked by recency and frequency — strictly below real
   contacts and team members.
2. A "recently opened files" feed for the command palette's empty state (a Drive
   *Recent* view can consume the same data later).
3. The shape extends to future kinds (search history, calendar attendees, …) by
   adding a typed table — not by widening a generic schema.
4. The user can clear what's been collected, per kind.

## Non-goals

- **Replacement for curated contacts.** Recents augment autosuggest; they don't
  become Contact rows.
- **Cross-user recents.** Each user has their own. Team-context writes touch the
  *typing user's* recents via the relay, never the team's.
- **Audit logging.** Recents is best-effort, lossy, prunable. The audit-shaped
  timeline is `file_events` ([FILE-HISTORY.md](FILE-HISTORY.md)).
- **Full-text search across recents.** See `SEARCH.md`.
- **Settings toggles in v1.** Per-kind *Clear* covers the privacy story; an
  `UserSettings.recents` enable flag is an additive JSON field on the existing
  per-user `settings.json` store later, if asked — no migration.
- **A Drive *Recent* view or new sidebar surfaces in v1.** The first consumers
  (autosuggest, palette empty state) need no new view.

## Why store rather than derive

Derivation at query time was investigated. One earlier claim here was wrong and is
corrected:

- **Mail**: `emails.recipientsAll` **does** exist (mail.db v3,
  `apps/api/src/lib/mail/schema.ts`, FTS-indexed) — recent mail recipients *are*
  derivable today.
- **Drive ACL**: a JSON array in the single `shared_paths.acl` column
  (`apps/api/src/lib/drive/sharedschema.ts`). No index on grantees — JSON1
  extraction is a full table scan per autosuggest keystroke.
- **Chat mentions**: `comment_mentions(chatName, email)` exists but has **no
  timestamp** — you can't order by recency.
- Raw addresses typed into chat bodies (not `@`-mentions) exist only in markdown.
- File opens are recorded nowhere at all.

So mail alone is derivable; the other contexts aren't, and ranking across contexts
wants one uniform `(lastUsedAt, useCount)` shape. Store.

## Architecture

```
apps/api/src/lib/recents/
  recents.ts          # Recents class — wired into UserHome like NotificationCenter
  schema.ts           # Drizzle: email_recents, file_recents
  db-config.ts        # version 1
```

No `sse-events.ts` — see § Reads.

DB location follows the per-domain convention:
`data/home/{userId}/eigen.recents/recents.db`, opened via `home.getLocalDatabase`
(the `eigen.notifications/notifications.db` precedent — no special registration).

Wired onto **`UserHome` only**. The base `Home` class gets a `hasRecents` boolean
mirroring `hasCalendar` — that's the relay guard, since `sendToHome` can target a
`TeamHome` or `GuestHome`. One new `HomeMessage` variant:
`{ type: 'recents:touch', … }`, dropped silently when `!hasRecents`.

## Data model

One typed table per kind — no generic `(kind, key, JSON)` bag. That's the correct
reading of CODE-STANDARDS §Typing (`$inferSelect`, types flow Elysia → Eden Treaty →
hooks) and the NotificationCenter precedent (flat typed columns). Adding a kind = a
migration + a typed domain method + a typed route response.

```typescript
// apps/api/src/lib/recents/schema.ts
export const emailRecents = sqliteTable('email_recents', {
    email: text('email').primaryKey(),       // lowercased on store; +tag aliases stay distinct
    lastUsedAt: integer('lastUsedAt', { mode: 'timestamp' }).notNull(),
    useCount: integer('useCount').notNull().default(1),  // frequency matters for correspondents
});

export const fileRecents = sqliteTable('file_recents', {
    ownerId: text('ownerId').notNull(),
    mountId: text('mountId').notNull(),
    pathId: text('pathId').notNull(),
    name: text('name').notNull(),             // denormalized at write — live resolution would
    mimeType: text('mimeType'),               // mean per-owner relay pulls + ACL checks per
    lastUsedAt: integer('lastUsedAt', { mode: 'timestamp' }).notNull(),  // read; staleness is
}, t => [primaryKey({ columns: [t.ownerId, t.mountId, t.pathId] })]);
// fine — the open target re-validates access anyway (404 on miss → prune the row)
```

Deliberately absent (cut in review): `context` (`'mail'|'chat'|'acl'` — nothing read
it), `firstUsedAt` (nothing read it), `useCount` on files (quick-open ranks by plain
recency, like every quick-open UI).

## Writes — all server-side, fire-and-forget with `.catch()`

The FE never writes recents. Each touch happens on the canonical commit path:

| Source | Where | Path to the actor's home |
|---|---|---|
| Mail send | `Mail.messageSend()` (`apps/api/src/lib/mail/mail-domain.ts`), after sendmail succeeds (failed sends don't pollute) | direct — own home |
| ACL grant | `Drive.updateACL()` added-entries diff | **relay** — runs in the owner's (possibly team) home. The actor is available as a full `User`: `Drive.updateACL` takes `actor?: User \| null` (`apps/api/src/lib/drive/drive.ts`) and `file_events` carries `actorUserId` / `actorEmail` (`apps/api/src/lib/mount/schema.ts`), so recents reads `actorUserId` directly to address the actor's home. No prerequisite left |
| Chat mention commit | `ChatRoom.postMessage` mention extraction (`chat.ts`); the actor's user id arrives from the chat route | **relay** |
| Collab doc open | the `GET /collab/:ownerId/:mountId/:pathId/info` handler, after its `canRead` check — the one seam all four eigendoc editors share (`useEigenDocEditorRoute` → `useCollabDocumentInfo`; its 60 s `staleTime` gives open-debouncing for free) | **relay** (`sendToHome(user.id, …)`) — zero FE code; future eigendoc apps are covered automatically |

Deliberately not covered in v1: **drive previews** of plain files (the `/preview`
route also serves folder-grid thumbnails — recording there would log every file the
user scrolls past; when previews should count, one POST from the shared
`PreviewProvider` covers all apps) and **`.eigenchat` opens** (no shared scaffold).

## Reads

Routes (`apps/api/src/routes/recents.ts`, `:ownerId` second segment, `requireSelf` +
`requireNonGuest` — the `space.ts` pattern):

```
GET    /recents/:ownerId/emails     ranked list for autosuggest merge
GET    /recents/:ownerId/files      most-recent-first for the palette
DELETE /recents/:ownerId/emails     Clear
DELETE /recents/:ownerId/files      Clear
```

FE: `recentsKeys` (ownerId-scoped) + `useRecentEmails` / `useRecentFiles` in
`packages/lib/src/core/recents/hooks/`, `staleTime` ~30 s, invalidations exported.

**No SSE event.** The own-home stream fans every event through all domain handlers,
and every consumer here is pull-on-demand: the tab that opened the file *caused* the
write; autosuggest reads a cached query while typing; the palette mounts its queries
when opened; cross-tab catches up via TanStack's default `refetchOnWindowFocus`. A
live-updating Drive *Recent* view would be the first surface to justify a push — add
the event together with that view, not before.

### Surfaces

- **`useContactSuggestions` gains recents as a third source** — ranked strictly
  below team members and personal contacts, deduped by lowercased email. That one
  hook lights up mail compose, ACL share, calendar attendees *and* the command
  palette's contact provider in one change. Addresses are recorded
  **unconditionally and deduped at read**: write-time exclusion of known contacts
  would couple every writer to contacts/team lookups, and read-side dedupe is
  needed regardless (an address can become a contact *after* it was recorded).
- **Command palette empty state** shows a *Recent files* section before any
  keystroke. No overlap to reconcile: the palette has no usage/frecency tracking
  anywhere (`rank.ts` is structural match quality only); files currently appear
  only via FTS search.

## Pruning

From the per-Home lifecycle — homes idle-evict on a per-type window (`UserHome`
5 minutes, `TeamHome` 30 minutes via `TEAM_HOME_IDLE_MS`,
`apps/api/src/lib/home/team-home.ts`) and there is no global home registry, so no
scheduler tick. Recents lives on `UserHome` only, so the 5-minute window is the
one that paces pruning:

- On `UserHome.init()`, fire-and-forget per kind: drop rows older than `maxAge`,
  then LRU-trim to `maxRows` by `lastUsedAt`.
- Limits: email — 500 rows / 365 days; file — 200 rows / 90 days.
- No useCount-weighted eviction (cut in review): at these sizes plain LRU is
  enough — a frequent contact is by definition recently used.

## Relationship to File History + Watch

Siblings sharing write moments, opposite directions — kept separate by design:

|                | `file_events` (activity/watch)          | Recents                              |
|----------------|------------------------------------------|--------------------------------------|
| Direction      | Owner-side: what happened *to this file* | Viewer-side: what *I* touched/used   |
| Visibility     | Shared with anyone holding read access   | Private to the user                  |
| Shape          | Append-only timeline, pruned by age      | LRU set, upsert per key              |
| Storage        | Owner's mount `metadata.db`              | User's own `recents.db`              |

The same commit path often writes both: an ACL grant records owner-side
`'acl-changed'` (timeline + watchers) *and* an actor-side email-recent touch
(autosuggest). Different facts — no one-source-of-truth violation. The shared
dependency is already satisfied: the actor-as-`User` threading through `Drive`
landed with File History, so recents reuses `actor` / `file_events.actorUserId`
as-is.

## Resolved questions

- **Naming**: *Recents* — matches the OS idiom for LRU-shaped data.
- **Email normalisation**: lowercase the whole address on store; keep `+tag`
  aliases distinct; preserve IDN as typed, match case-insensitively.
- **Mail-send write timing**: after sendmail succeeds.
- **GDPR / user delete**: removing the home directory removes `recents.db` by
  layout; relay touches are dropped for non-existent homes.
- **Settings placement**: moot in v1 — the two *Clear* actions live in Space
  settings, next to where a future enable toggle would go.

## Files

| File                                                              | Purpose                                                        |
|-------------------------------------------------------------------|----------------------------------------------------------------|
| `packages/lib/src/types/recents.ts`                               | `EmailRecent`, `FileRecent` shared types                       |
| `apps/api/src/lib/recents/recents.ts`                             | `Recents` domain class (touch, list, clear, prune)             |
| `apps/api/src/lib/recents/schema.ts` + `db-config.ts`             | Tables + v1 config                                             |
| `apps/api/src/lib/home/home.ts` / `user-home.ts`                  | `hasRecents` flag; UserHome wiring                             |
| `apps/api/src/lib/home/home-relay.ts`                             | `recents:touch` `HomeMessage` variant, guarded by `hasRecents` |
| `apps/api/src/lib/mail/mail-domain.ts`                            | Touch recipients after `messageSend` success                   |
| `apps/api/src/lib/drive/drive.ts`                                 | `updateACL` added-entries diff → relay touch (reuses the landed `actor: User` threading) |
| `apps/api/src/lib/chat/chat.ts`                                   | Mention commit → relay touch                                   |
| `apps/api/src/routes/collab.ts`                                   | `info` handler → relay touch after `canRead`                   |
| `apps/api/src/routes/recents.ts`                                  | GET/DELETE per kind, `requireSelf` + `requireNonGuest`         |
| `packages/lib/src/core/recents/hooks/use-recents.ts`              | `useRecentEmails`, `useRecentFiles`, `recentsKeys`, invalidations |
| `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` | Recents as third suggestion source                             |
| `packages/lib/src/core/command-palette/`                          | *Recent files* section in the empty state                      |
| Space settings                                                     | Two *Clear my recents* actions                                 |
