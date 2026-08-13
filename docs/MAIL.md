# Mail

> **TLDR**: `apps/mail` is a personal email client over a per-user Maildir. The React app talks to a thin
> Elysia router (`routes/mail.ts`) that delegates to the `Mail` domain class (`mail-domain.ts`) over a
> swappable `MailStore` (today only `MaildirStore`), backed by a per-user `mail.db` (SQLite + FTS5). Mail is
> **personal-only** — every route is `requireSelf`, there is no sharing/ACL. The list is keyset-paginated and
> optimistically cached; sync runs off the request path. This doc is the app-level map; the on-disk Maildir
> format, flag encoding, sync-engine mechanics, and Dovecot coexistence live in **[IMAP.md](IMAP.md)**.

## Architecture

Four backend layers plus the React app. Requests flow down; changes flow back up as SSE.

```
apps/mail (React)                          apps/api (Elysia)
  route + hooks ──── HTTP (Eden Treaty) ──►  routes/mail.ts        thin: requireNonGuest + requireSelf
  useEmails / use-draft / useMailboxes           │                 then getMailClient(user) → home.mail
  sse-handlers.ts ◄──────── SSE ──────┐          ▼
                                      │     lib/mail/mail.ts        route-facing helpers (getMailClient,
                                      │          │                  mailboxDeliver, attachFromDrive, …)
                                      │          ▼
                              home.broadcast  mail-domain.ts        class Mail — draft/send/iMIP/SSE/notifs
                                      ▲          │
                                      │          ▼
                                      │     mail-store.ts           MailStore interface + MailStoreEvents
                                      └──────  maildir-store.ts     the only impl: Maildir FS + sync engine
                                                 │
                                                 ▼
                                     maildb.ts (MailDB, mail.db)  +  mail-parse.ts (parseEml + DOMPurify)
                                                 │
                                                 ▼
                                     Maildir on disk  ── see IMAP.md
```

`MailStore` is a deliberate seam: a second backend (JMAP/Stalwart) is proposed in
[PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) but not built. See
[IMAP.md § Code Architecture](IMAP.md#code-architecture) for the storage side in depth.

## Data model

The `emails` table **is** the `EmailSummary` DTO — the DB row is returned to the client with no mapping
(`packages/lib/src/types/mail.ts`). Columns: `id` (Maildir unique id, TEXT PK), `filename`, `subject`,
`fromShort`/`fromAddress`, `toShort`/`toAddress`, `recipientsAll`, `textShort` (plain-text body — full text
in the DB for FTS, capped only at the list-response seam), `size`, `date`, the `isRead`/`isFlagged`/
`isDraft`/`isReplied`/`hasAttachments` booleans, `mailbox`, and `created/updatedAt`. The full parsed message
(`Email = ParsedMail & EmailSummary`) is re-parsed from the `.eml` on demand; only the summary is cached.

`mail.db` lives at `<home>/eigen.mail/mail.db`. `MAIL_DB_CONFIG` (`db-config.ts`, `currentVersion: 4`):
v1 creates `emails` + base indexes; v2 adds the address columns; v3 adds the `emails_fts` FTS5 table (porter
+ unicode61) with `emails_ai/ad/au` sync triggers; v4 adds `idx_emails_mailbox_date (mailbox, date DESC, id
DESC)` — the composite index backing keyset pagination. **`emailLabels`/`emailsToLabels` are vestigial**:
defined and migrated in v1, but nothing in the FE or BE reads or writes them.

## Mailboxes and the naming gotcha

`STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']` (`lib/core/constants.ts`) — the
empty string is INBOX. `canonicalMailbox()` (`mail-domain.ts`) normalizes any case (`inbox`/`Trash`/`trash`)
to canonical form at every domain entry point. **Three representations of "the inbox" coexist** — the #1
source of subtle mail bugs; never compare mailbox strings without knowing the layer:

| Layer | Inbox is | Others |
|---|---|---|
| BE canonical (DB `mailbox` column, SSE payloads, `canonicalMailbox`) | `''` | canonical case (`Sent`, `Archive`) |
| FE query keys (`emailKeys.list`) | `'inbox'` | lowercased |
| URL segment | `box/inbox` | lowercased |

The mailbox list search box passes the URL `filterId` (`'inbox'`) **verbatim** to the search endpoint —
`Mail.search` re-canonicalizes it, so passing `''` would strip the filter and search every mailbox. The
optimistic list patch sidesteps all of this by matching on message `id`, not the mailbox key. See
[IMAP.md § Mailbox Structure](IMAP.md#mailbox-structure) for the on-disk `.Mailbox` layout.

## API routes

All authed routes are `requireNonGuest` + `requireSelf(ownerId, user.id)` (`routes/mail.ts`).

```
POST   /mail/deliver/:to                                  inbound delivery (requireLocalhost — Postfix)
GET    /mail/:ownerId/mailboxes                           mailboxes + unread counts
GET    /mail/:ownerId/mailbox/:mailboxPath                list messages — ?limit&beforeDate&beforeId (keyset)
POST   /mail/:ownerId/mailbox                             create mailbox
GET    /mail/:ownerId/mailbox-exists/:mailboxPath         existence check
GET    /mail/:ownerId/message/:id                         full parsed message (draft: sidecar overlay)
GET    /mail/:ownerId/message/:id/download                raw .eml
DELETE /mail/:ownerId/message/:id                         permanent delete (→ MAIL_DELETED)
PUT    /mail/:ownerId/message/move                        move to mailbox (→ MAIL_MOVED)
PUT    /mail/:ownerId/message/move-to-trash               move to Trash (→ MAIL_MOVED)
POST   /mail/:ownerId/message/copy                        copy raw bytes to mailbox
PUT    /mail/:ownerId/message/draft                       create / update draft (→ MAIL_DRAFT_UPDATED)
POST   /mail/:ownerId/message/draft/attachment            upload draft attachment → tempId
POST   /mail/:ownerId/message/draft/attachment-from-drive stage a Drive file as a draft attachment
POST   /mail/:ownerId/message/send                        send draft (→ Sent, MAIL_SENT)
PUT    /mail/:ownerId/message/:id/read                    set read/unread (→ MAIL_READ_CHANGED)
PUT    /mail/:ownerId/message/:id/flagged                 set star (→ MAIL_FLAGS_CHANGED)
POST   /mail/:ownerId/message/:id/attachments/save-to-drive   save received attachments into Drive
GET    /mail/:ownerId/message/:id/attachment/:index/:fileName download one attachment
```

## Reading and the list (FE)

`useEmails(mailboxPath)` (`packages/lib/src/core/mail/hooks/use-emails.ts`) is a `useInfiniteQuery` returning
a flat `emails` array. `useMailList` (`apps/mail/src/components/mail/hooks/use-mail-list.ts`) owns the ordered
rows (stable date-desc sort over the loaded window), selection, and the **id-tracked** keyboard cursor —
shared with the shortcuts layer so both act on identical state. `EmailList` (`email-list.tsx`) virtualizes
the rows (`@tanstack/react-virtual`) and fetches the next page as the end nears; it snaps the virtualizer to
the top when the view identity changes (mailbox switch or entering/leaving search) via a `resetKey`, so the
scroll window can't desync from a shrunken/grown list. The toolbar search box hits the server FTS endpoint
(`useSearchQuery`, scoped to the current mailbox) instead of filtering the loaded window.

## Performance design

At a real account shape (~50k Inbox + ~50k Archive) the naive list was ~34 MB per fetch and every mutation
re-fetched the whole mailbox. Four shipped changes fix it (measured on a dev Mac):

| Concern | Before | After |
|---|---|---|
| First paint of a 50k mailbox | ~34 MB, whole list | ~130 KB, one 200-row page |
| `listMessages` route latency | ~301 ms (sync on the request path) | ~5 ms (serve-stale, sync in background) |
| Cold index (first sync) | 92 s baseline @100k, per-row inserts | batched, ~1.7× faster @10k+10k |
| Archive with N pages loaded | ~8 full-list refetches | 0 |

1. **Keyset pagination.** `MailDB.listMessages` uses a composite `(date, id)` cursor (`WHERE (date,id) <
   (?,?) ORDER BY date DESC, id DESC LIMIT`) backed by the v4 index; the route caps `textShort` at 200 chars
   in the response only (the full body stays in the DB for FTS). Page size 200, max 500.
2. **Optimistic cache updates.** move/read/flag/delete patch the cached pages by id (`patchEmailInLists`)
   inside an `onMutate` snapshot → patch → rollback-on-error contract, instead of invalidating. The UI is
   instant; no mutation-path refetch.
3. **Own-echo suppression.** The server echoes every mutation back to its originator over SSE. Each mutation
   records the echo it expects (`markRecentMailMutation`) in a short-TTL per-tab registry; the SSE handler
   `consumeRecentMailMutation`s it and skips the list refetch (keeping the cheap counts/search invalidations).
   Other clients' changes are unaffected (no registry entry).
4. **Non-blocking sync + batched cold-index.** `MaildirStore.listMessages` serves the DB immediately and
   reconciles via a fire-and-forget `syncMailbox` (it blocks only on the first open of an empty mailbox); the
   cold-index loop parses in chunks of 250 and bulk-inserts each chunk in one `insertEmails` upsert
   transaction. See [IMAP.md § Sync Engine](IMAP.md#sync-engine) for the reconcile diff.

Deferred (Step 4, only for big imports): moving `parseEml` into a worker so a cold index of tens of
thousands of messages doesn't saturate the shared event loop. A one-time bulk import still causes a stretch
of slowness while the background index drains.

## Sync and real-time

The store exposes a change stream `MailStoreEvents` — `received(email, isNew)`, `flagsChanged`, `deleted` —
which `Mail.init` wires to `home.broadcast(buildMailEvent(...))` (SSE via `sse-events.ts`) and, for new mail,
`home.notifications.persist({ tag: 'mail:new', coalesce: true })` so a burst collapses to one notification.
SSE event types: `MAIL_RECEIVED`, `MAIL_MOVED`, `MAIL_DELETED`, `MAIL_READ_CHANGED`, `MAIL_FLAGS_CHANGED`,
`MAIL_DRAFT_UPDATED`, `MAIL_SENT`. The FE `sse-handlers.ts` maps each to cache invalidation. See
[SSE.md](SSE.md) and [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md); the fs-watcher and reconcile mechanics
are in [IMAP.md § File Watching](IMAP.md#file-watching).

## Compose, drafts, and send

`messageHandleDraft` (`mail-domain.ts`) runs a two-mode draft state machine:

- **Fast save** — writes only the `DraftMeta` JSON sidecar + a light DB content update; skips the EML
  rebuild. Used when no attachments changed and the last full save is recent (`FULL_SAVE_INTERVAL_MS` = 5
  min). This leaves the on-disk `.eml` stale until a full save (external IMAP clients see old content).
- **Full save** — rebuilds the RFC 5322 `.eml` (`createEmlContent`), baking Drive reference-pill HTML in.

`messageGet` overlays the sidecar onto the parsed draft so the composer shows what the user typed, not the
baked markup. `Mail.destruct` force-flushes pending sidecars so a restart never leaves a stale draft.

The composer (`apps/mail/src/components/mail/email-draft.tsx` + its `hooks/use-draft.ts`) handles To/Cc/Bcc
via `ContactAutosuggest`, a `LightEditor` (Tiptap) body, drag/paste-to-attach, debounced (2.5 s) autosave
keyed off a fingerprint diff, a forced full save on unmount, signature injection for new/reply drafts, and
Mod+Enter to send. Reply/forward are FE-only (quoted-body composition in `use-mail-actions.ts`). Sending
does a full save, converts to `OutboundMail` (`draftToOutboundMail`), and calls `sendMail` (`lib/core/
mailer.ts`) — sendmail transport unless `SMTP_HOST` is set, and **skipped in dev/test** (logged, not sent).
On success the message moves to `Sent`, the draft flag clears, and `MAIL_SENT` fires.

## Attachments

Uploaded files stream to a draft-temp staging area (`uploadDraftAttachment` → `tempId`), passed back as
`tempAttachmentIds` on the next draft save. Drive **files** are copied through the same staging path
(`attachFromDrive`); Drive **containers** (docs, folders) are added as `driveReferences` instead and rendered
as reference-pill `<a>` links at save/send (`renderAttachmentPills`, `mail-template.ts`) — see
[MEDIA-REFERENCES.md](MEDIA-REFERENCES.md). Received attachments re-parse from the `.eml` on read and can be
copied into Drive (`saveAttachmentsToDrive`); `text/calendar` parts are additionally summarized into a typed
`Attachment.calendarInvite` for the invite widget — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations).

## Delivery and inbound

`POST /mail/deliver/:to` is unauthenticated but `requireLocalhost` (trusts Postfix on localhost): it resolves
the user by address, appends the raw bytes to INBOX, then synchronously scans for iMIP calendar parts
(`processInboundImip`) — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations). On a
user's first mail init a welcome message is written straight into their INBOX (`welcome.ts`, gated by the
`onboarding.welcomeMail` server setting), bypassing SMTP.

## Protocol access (IMAP/CalDAV/WebDAV)

There is **no in-repo IMAP server**. The Maildir is written in a Dovecot-compatible on-disk format; Dovecot
runs as a separate container (`docker/dovecot/`) serving real IMAP off the same files. It authenticates via
its `checkpassword` mechanism → Eigen's `POST /internal/auth/verify` → `verifyProtocolAuth`
(`lib/auth/protocol-auth.ts`), which tries an app-password (better-auth API key) first and falls back to the
primary account password (the fallback fails if 2FA is on). The same `verifyProtocolAuth` is shared by CalDAV
and WebDAV. Full Dovecot config/deployment is in [IMAP.md](IMAP.md#dovecot-configuration-reference).

## Keyboard shortcuts and settings

Opt-in Gmail-style shortcuts (`use-mail-shortcuts.ts`; cheat sheet in `mail-shortcuts-dialog.tsx`, opened
with `?`) cover navigation (`j`/`k`/`o`/`u`), actions (`e`/`#`/`s`/`r`/`a`/`f`/`[`/`]`), `g`-chord jumps, and
`*`-chord bulk selection; compose sends on ⌘/Ctrl+Enter. Mail preferences live in the **space** app, not
`apps/mail`: `apps/space/src/components/space/mail-prefs-section.tsx` (the `keyboardShortcuts` toggle +
`autoAdvance` select) and `signature-section.tsx` (a single rich-text signature), both stored under
`UserSettings.email` (`packages/lib/src/types/settings.ts`) and consumed by the mail route via
`useSpaceSettings`.

## Not yet implemented / limitations

- `emailLabels`/`emailsToLabels` tables are **vestigial** — created by migration, never used.
- **Step 4 (worker offload) is deferred** — a cold index of tens of thousands of messages saturates the
  shared event loop until it drains (only matters for one-time bulk imports). The move also covers the
  mailparser-audit residuals: `DOMPurify.sanitize` still runs uncapped synchronous CPU on untrusted HTML
  (the `htmlToText` input is truncated at 2 MB, DOMPurify's isn't), and `html-to-text`'s stack-overflow
  catch on pathologically nested HTML rejects the whole parse (that one email becomes unreadable).
- The summary/cold-index parse fully decodes + buffers attachment content it never reads (audit #12) —
  a `skipAttachmentContent` flag is deliberately unbuilt; add it only if a real large-mailbox profile
  justifies it (largely subsumed by the worker move).
- Fast-saved drafts leave the on-disk `.eml` stale until a full save — external IMAP clients see old content.
- Primary-password protocol auth fails when 2FA is enabled (use an app password).
- A second `MailStore` backend (JMAP/Stalwart) is proposed only — see
  [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md).

## Where the code lives

- **Backend**: `apps/api/src/lib/mail/` — the whole stack in the diagram above (routes are the one exception,
  `apps/api/src/routes/mail.ts`). Shared with other protocols: `lib/auth/protocol-auth.ts`, `lib/core/mailer.ts`.
- **Shared**: `packages/lib/src/core/mail/` — hooks (`hooks/use-emails.ts`, `use-mailboxes.ts`, `use-draft.ts`),
  query keys, optimistic-patch helpers, `sse-handlers.ts`. Types in `packages/lib/src/types/mail.ts`.
- **Frontend**: `apps/mail/src/components/mail/` — list, detail, composer, plus their `hooks/` (list state,
  actions, shortcuts). The route wiring sits in `apps/mail/src/routes/`. Mail *settings* live in
  `apps/space/src/components/space/`.

Storage internals (Maildir layout, flag encoding, sync-engine diff, Dovecot): **[IMAP.md](IMAP.md)**.
