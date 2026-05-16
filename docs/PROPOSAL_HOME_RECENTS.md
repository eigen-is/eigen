# Proposal: Per-Home Recents

> **TLDR**: A new per-user module `home.recents` that records "implicit usage" — recently used
> email addresses and recently opened files — so the data feeds back into autosuggest and
> quick-open UIs the next time the user reaches for them. **One typed Drizzle table per kind**
> (no generic `(kind, key, JSON)` bag) so types flow Elysia → Eden Treaty → hooks → components
> like every other domain. Lives only on `UserHome`; team-context writes (team chat tag commit)
> go through `home-relay.ts`. Auto-pruned from the per-Home lifecycle — no global scheduler.
> Settings-gated per kind; user can clear.

## Goals

1. An email typed into mail compose / ACL share / chat tag that isn't in contacts or team
   membership reappears in autosuggest next time, ranked by recency and frequency.
2. A "recently opened files" feed available to a Drive *Recent* view and to the app launcher's
   quick-open palette.
3. The shape extends to future kinds (search-bar history, calendar attendees, …) by adding a new
   typed table — not by widening a generic schema.
4. The user can disable each kind in settings and clear what's been collected.

## Non-goals

- **Replacement for curated contacts.** Recents augment autosuggest; they don't become Contact
  rows.
- **Cross-user recents.** Each user has their own. Team chats touch the *typing user's* recents,
  not the team's.
- **Audit logging.** Recents is best-effort, lossy, prunable; not a place for security-relevant
  events.
- **Full-text search across recents.** See `PROPOSAL_SEARCH.md`.
- **Derivation from existing data** (Sent folder, ACL grants, chat mentions). Investigated and
  rejected — see *Why store rather than derive* below.

## Why now

Three Eigen UIs already need a "remember what I typed" hint and currently throw it away on every
keystroke:

| UI                                                              | Existing merge                                |
|-----------------------------------------------------------------|-----------------------------------------------|
| Mail compose To/Cc/Bcc (`ContactAutosuggest`)                    | contacts + team members                       |
| Drive ACL share dialog (`DriveAccessListEdit` → same component)  | contacts + team members                       |
| Chat `@`-mention (`ChatPlayerSuggest`)                           | contacts + team members + room members        |

The first two already converge on the `useContactSuggestions` hook — a clean plug-in point. The
chat suggest re-implements the merge in parallel; bringing it onto the same hook is *not* part of
this proposal but is unblocked by it.

### Why store rather than derive

A natural alternative is to derive recents at query time from Sent mail, ACL grants, and chat
mentions. We investigated and ruled it out:

- **Mail Sent**: `emails` table has `mailbox`, `date`, `fromShort` — but **To/Cc/Bcc are not
  columns**. Recipient addresses only exist inside the RFC822 blob on disk.
- **Drive ACL**: stored as a JSON array in a single `shared_paths.acl` column. No index on
  grantees; SQLite JSON1 extraction does a full table scan per autosuggest call.
- **Chat mentions**: a normalised `comment_mentions(chatName, email)` table exists, but has no
  timestamp — you can't order by recency.

Even if those three could be made queryable, raw emails *typed* into chat bodies (not
`@`-mentions) are only in markdown text. Derivation can't see them at all.

## Architecture

A new domain module in the existing style:

```
apps/api/src/lib/recents/
  recents.ts          # Recents class — wired into Home like Contacts / NotificationCenter
  schema.ts           # Drizzle: one table per kind
  db-config.ts        # CurrentVersion + migrations
  sse-events.ts       # buildEvent(...) for recents:* SSE
```

DB location follows the per-domain convention:
`data/home/{userId}/eigen.recents/recents.db`.

Wired onto **`UserHome` only** (`TeamHome`/`OrgHome`/`GuestHome` skip it). The base `Home` class
gets a `hasRecents: boolean` flag mirroring `hasCalendar`, so call sites in mail / ACL / chat can
check before touching.

### One typed table per kind, not a generic bag

We considered a single `recents(kind, key, payload TEXT, useCount, ...)` table — clean to extend,
ugly under the project's typing rules (`CODE-STANDARDS.md` §Typing: no untyped JSON, types flow
end-to-end via `$inferSelect`, no `as any`). The precedent is `NotificationCenter`, which handles
real polymorphism via a typed `type` column plus flat typed columns — *not* JSON payloads.

So: **one Drizzle table per kind**, sharing the same lifecycle columns (`firstUsedAt`,
`lastUsedAt`, `useCount`) plus the kind's own typed fields. Adding a kind = a migration + a typed
domain method + a typed route response. The repetition is the price of typed end-to-end flow, and
the per-kind tables let each kind grow its own indexes if it ever needs them (e.g. filtering
recent files by mimeType).

### Two kinds at launch

| Kind     | Table                | Kind-specific columns          | Written by                                                       | Read by                                       |
|----------|----------------------|--------------------------------|------------------------------------------------------------------|-----------------------------------------------|
| `email`  | `email_recents`      | `email`, `context`             | `Maildir.send()`, `Drive.setAcl()`, chat tag commit (via relay)  | `useContactSuggestions` (mail / ACL share UI) |
| `file`   | `file_recents`       | `ownerId`, `mountId`, `pathId` | each app's viewer-mount hook (drive/docs/sheets/slides/stickies) | Drive *Recent* view, app launcher quick-open  |

The `email.context` value is one of `'mail' | 'chat' | 'acl'` so the suggest UI can weight by
context if useful. `file_recents` stores the entity key only — name/mimeType resolve live from
Drive on read, so renames never go stale.

Speculative future kinds (search, calendar attendees, emoji picker, command palette) are out of
scope for v1; each will land alongside the UI that needs it.

## Wiring

### Email recents

- **Writes happen server-side on the canonical commit path** (mail send, ACL grant, chat tag
  commit). Fire-and-forget with `.catch()` per the project rule on `await`. No FE double-touch —
  the FE only reads.
- **Cross-home subtlety**: chat tag commits run in the *team's* Home context (where the chat
  lives). The recent belongs to the *typing user*. The handler dispatches `sendToHome(userId,
  { type: 'recents:touch-email', ... })` via `home-relay.ts` so the sharding seam stays clean.
  A new variant on the `HomeMessage` union.
- **Read** via a new `useEmailSuggest(prefix)` hook in `packages/lib/src/core/recents/hooks/`.
  `useContactSuggestions` calls it and merges the result with contacts + team members; ranking
  favours real contacts and team members over recents, but a frequent recent edges out a stale
  contact.

### File recents

- Each viewer's main mount calls `useTouchFileRecent(ownerId, mountId, pathId)` once on open,
  debounced — re-mounts in the same minute don't multi-count.
- Drive grows a virtual *Recent* node backed by a new endpoint; the app launcher's quick-open
  palette consumes the same data.

### SSE

A new `SSEventType.RECENTS_TOUCHED` value, broadcast on every write with the kind name and the
identifying key. Frontend SSE handler invalidates the matching TanStack Query key
(`recentsKeys.email(ownerId, ...)`, `recentsKeys.file(ownerId)`). Multi-tab / multi-device users
stay in sync.

### Routes

`apps/api/src/routes/recents.ts`, second path segment `:ownerId` per the project convention. The
caller's user id must match the segment (no cross-user reads). Endpoint shapes are typed
per-kind, not generic — Eden Treaty surfaces them as concrete types on the FE.

### Settings

A `recents` sub-object on `UserSettings`, one entry per kind, shape matching the existing
nested-feature pattern (`ServerSettings.notifications`):

```typescript
recents?: {
    email?: { enabled?: boolean };  // default true
    file?:  { enabled?: boolean };  // default true
};
```

Each server-side write helper short-circuits when its kind is disabled, so the gate sits in one
place per kind, not at every call site. Toggling off does not auto-clear — a *Clear my recents*
action calls a per-kind clear method.

A new *Recents* page lives under Space → App settings.

## Pruning

Pruning runs **from the per-Home lifecycle**, not from a global scheduler tick — there is no
`activeUserHomes()` registry, and Homes idle-evict every 5 minutes anyway.

- On `UserHome.init()`, after settings load, fire-and-forget the per-kind prune.
- Prune policy per kind: drop rows older than `maxAge`, then trim to `maxRows` keeping the most
  recently used. Rows with `useCount = 1` get evicted first so a frequent contact survives the
  trim even when a one-off recent is more recent.

Initial limits (revisit after telemetry): email — 500 rows, 365 days; file — 200 rows, 90 days.

## Open questions

1. **Naming.** *Recents* fits LRU-shaped data and matches the OS idiom; the alternatives
   (*history*, *usage*) read worse. Lean keep.
2. **Settings UI placement.** One consolidated *Recents* page in Space, or split per app (Mail
   settings → email recents toggle, Drive settings → file recents toggle)? Consolidated reads
   better; distributed is more discoverable in context.
3. **Email key normalisation.** Lowercase the whole address (standard). Strip `+tag` aliases —
   probably not, since `alice+ml@…` and `alice@…` are legitimately different recipients in some
   workflows. Confirm.
4. **IDN / Unicode emails.** Punycode the domain on store, or preserve as-typed? Preserve and
   match case-insensitively per RFC 5321.
5. **GDPR / user delete.** A user's recents are wiped when their Home directory is removed
   (cascade by filesystem layout). Worth confirming there's no orphan write path that survives
   a delete.
6. **Server-side touch from `Maildir.send()` — write before or after sendmail returns?** Likely
   after, on success, so failed sends don't pollute. Confirm.
